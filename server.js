const express  = require('express');
const cors     = require('cors');
const { exec } = require('child_process');
const fs       = require('fs');
const https    = require('https');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

const ARCHIVE_ACCESS = process.env.ARCHIVE_ACCESS_KEY;
const ARCHIVE_SECRET = process.env.ARCHIVE_SECRET_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET   = process.env.ADMIN_SECRET || 'animelk2026';

// Lazy Supabase — startup crash නෑ
function getDb() {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env vars missing');
    return createClient(SUPABASE_URL, SUPABASE_KEY);
}

app.use(cors());
app.use(express.json());

// ── Auth ──
function authCheck(req, res, next) {
    const secret = req.headers['x-admin-secret'];
    if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ── Health ──
app.get('/', (req, res) => {
    res.json({ status: 'AnimeLK Uploader Running ✓', time: new Date() });
});

// ── Upload ──
app.post('/upload', authCheck, async (req, res) => {
    const { m3u8_url, anime_id, anime_name, episode_number, subtitle_url, subtitle_url_en, intro_start } = req.body;
    if (!m3u8_url || !anime_id || !episode_number) {
        return res.status(400).json({ error: 'Required fields missing' });
    }
    res.json({ status: 'processing', message: 'Background download started' });
    processUpload({ m3u8_url, anime_id, anime_name, episode_number, subtitle_url, subtitle_url_en, intro_start })
        .catch(err => console.error('[Upload Error]', err));
});

// ── Status ──
app.get('/status/:anime_id/:ep', authCheck, async (req, res) => {
    try {
        const db = getDb();
        const { data } = await db.from('episodes')
            .select('video_url, created_at')
            .eq('anime_id', req.params.anime_id)
            .eq('episode_number', parseInt(req.params.ep))
            .single();
        res.json({ done: !!data?.video_url, data });
    } catch(e) {
        res.json({ done: false, error: e.message });
    }
});

// ── Process ──
async function processUpload({ m3u8_url, anime_id, anime_name, episode_number, subtitle_url, subtitle_url_en, intro_start }) {
    const safeName  = (anime_name || anime_id).replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const filename  = `${safeName}-ep${episode_number}.mp4`;
    const tmpPath   = `/tmp/${filename}`;
    const identifier= `animelk-${safeName}-ep${episode_number}-${Date.now()}`;

    console.log(`[Process] Starting: ${filename}`);

    try {
        console.log('[Step 1] ffmpeg download...');
        await runCommand(`ffmpeg -i "${m3u8_url}" -c copy -bsf:a aac_adtstoasc -y "${tmpPath}"`, 300000);
        console.log('[Step 1] Done');

        console.log('[Step 2] archive.org upload...');
        const videoUrl = await uploadToArchive(tmpPath, filename, identifier, anime_name, episode_number);
        console.log('[Step 2] Done:', videoUrl);

        console.log('[Step 3] Supabase save...');
        const db = getDb();
        const epData = {
            anime_id,
            episode_number: parseInt(episode_number),
            video_url: videoUrl,
            subtitle_url: subtitle_url || null,
            subtitle_url_en: subtitle_url_en || null,
            intro_start: intro_start || null
        };

        const { data: existing } = await db.from('episodes')
            .select('id')
            .eq('anime_id', anime_id)
            .eq('episode_number', parseInt(episode_number))
            .single();

        if (existing) {
            await db.from('episodes').update(epData).eq('id', existing.id);
        } else {
            await db.from('episodes').insert([epData]);
        }
        console.log('[Step 3] Supabase saved ✓');

    } catch (err) {
        console.error('[Process Error]', err.message);
    } finally {
        if (fs.existsSync(tmpPath)) {
            fs.unlinkSync(tmpPath);
            console.log('[Cleanup] Done');
        }
    }
}

function uploadToArchive(filePath, filename, identifier, animeName, epNumber) {
    return new Promise((resolve, reject) => {
        const fileSize   = fs.statSync(filePath).size;
        const fileStream = fs.createReadStream(filePath);
        const options = {
            hostname: 's3.us.archive.org',
            path: `/${identifier}/${filename}`,
            method: 'PUT',
            headers: {
                'Authorization': `LOW ${ARCHIVE_ACCESS}:${ARCHIVE_SECRET}`,
                'Content-Type': 'video/mp4',
                'Content-Length': fileSize,
                'x-archive-meta-mediatype': 'movies',
                'x-archive-meta-title': `${animeName} Episode ${epNumber}`,
                'x-archive-meta-subject': 'anime',
                'x-archive-auto-make-bucket': '1'
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    resolve(`https://archive.org/download/${identifier}/${filename}`);
                } else {
                    reject(new Error(`Archive upload failed: ${res.statusCode} ${body}`));
                }
            });
        });
        req.on('error', reject);
        fileStream.pipe(req);
    });
}

function runCommand(cmd, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const proc = exec(cmd, { timeout }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
        });
        proc.stdout?.on('data', d => process.stdout.write(d));
        proc.stderr?.on('data', d => process.stderr.write(d));
    });
}

app.listen(PORT, () => console.log(`AnimeLK Uploader running on port ${PORT}`));
