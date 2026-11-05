const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Parser = require('rss-parser');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Cơ sở dữ liệu tương thích 100% mọi hệ điều hành Cloud (Render Linux / Windows) không lo lỗi GLIBC_2.38
function createJsonCloudDatabase(filePath) {
    let state = {
        seq: { users: 0, files: 0, custom_sources: 0 },
        users: [],
        files: [],
        custom_sources: [],
        disabled_sources: []
    };

    if (fs.existsSync(filePath)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            state = { ...state, ...loaded, seq: { ...state.seq, ...(loaded.seq || {}) } };
        } catch (_) {}
    }

    function save() {
        try {
            fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
        } catch (e) {
            console.error('Lỗi lưu DB JSON:', e.message);
        }
    }

    return {
        serialize(fn) {
            if (typeof fn === 'function') fn();
        },
        run(sql, params, cb) {
            if (typeof params === 'function') {
                cb = params;
                params = [];
            }
            params = params || [];
            const q = sql.replace(/\s+/g, ' ').trim();

            if (/^CREATE TABLE/i.test(q)) {
                if (cb) cb.call({ lastID: 0, changes: 0 }, null);
                return;
            }

            if (/^INSERT INTO users/i.test(q)) {
                const [username, password] = params;
                if (state.users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) {
                    if (cb) cb.call({}, new Error('UNIQUE constraint failed: users.username'));
                    return;
                }
                const id = ++state.seq.users;
                state.users.push({ id, username, password });
                save();
                if (cb) cb.call({ lastID: id, changes: 1 }, null);
                return;
            }

            if (/^INSERT INTO files/i.test(q)) {
                const [userId, originalName, filename, size, uploadDate] = params;
                const id = ++state.seq.files;
                state.files.push({
                    id,
                    userId: Number(userId),
                    originalName,
                    filename,
                    size: Number(size),
                    uploadDate
                });
                save();
                if (cb) cb.call({ lastID: id, changes: 1 }, null);
                return;
            }

            if (/^DELETE FROM files/i.test(q)) {
                const [id, userId] = params;
                const before = state.files.length;
                state.files = state.files.filter(
                    (f) => !(String(f.id) === String(id) && String(f.userId) === String(userId))
                );
                save();
                if (cb) cb.call({ changes: before - state.files.length }, null);
                return;
            }

            if (/^INSERT INTO custom_sources/i.test(q)) {
                const [sourceId, name, siteUrl, rssUrl, mode, createdAt] = params;
                const id = ++state.seq.custom_sources;
                state.custom_sources.push({ id, sourceId, name, siteUrl, rssUrl, mode, createdAt });
                save();
                if (cb) cb.call({ lastID: id, changes: 1 }, null);
                return;
            }

            if (/^DELETE FROM custom_sources/i.test(q)) {
                const [idOrSid1, idOrSid2] = params;
                const before = state.custom_sources.length;
                state.custom_sources = state.custom_sources.filter(
                    (s) => String(s.id) !== String(idOrSid1) && String(s.sourceId) !== String(idOrSid2)
                );
                save();
                if (cb) cb.call({ changes: before - state.custom_sources.length }, null);
                return;
            }

            if (/^INSERT OR IGNORE INTO disabled_sources/i.test(q)) {
                const [sourceId] = params;
                const lower = String(sourceId).toLowerCase();
                if (!state.disabled_sources.includes(lower)) {
                    state.disabled_sources.push(lower);
                    save();
                }
                if (cb) cb.call({ changes: 1 }, null);
                return;
            }

            if (/^DELETE FROM disabled_sources/i.test(q)) {
                state.disabled_sources = [];
                save();
                if (cb) cb.call({ changes: 1 }, null);
                return;
            }

            if (cb) cb.call({ lastID: 0, changes: 0 }, null);
        },
        get(sql, params, cb) {
            if (typeof params === 'function') {
                cb = params;
                params = [];
            }
            params = params || [];
            const q = sql.replace(/\s+/g, ' ').trim();

            if (/FROM users WHERE username = \? AND password = \?/i.test(q)) {
                const [username, password] = params;
                const row = state.users.find((u) => u.username === username && u.password === password) || null;
                if (cb) cb(null, row ? { id: row.id, username: row.username } : undefined);
                return;
            }

            if (/FROM files WHERE id = \? AND userId = \?/i.test(q)) {
                const [id, userId] = params;
                const row =
                    state.files.find((f) => String(f.id) === String(id) && String(f.userId) === String(userId)) ||
                    undefined;
                if (cb) cb(null, row);
                return;
            }

            if (cb) cb(null, undefined);
        },
        all(sql, params, cb) {
            if (typeof params === 'function') {
                cb = params;
                params = [];
            }
            params = params || [];
            const q = sql.replace(/\s+/g, ' ').trim();

            if (/FROM files WHERE userId = \?/i.test(q)) {
                const [userId] = params;
                const rows = state.files
                    .filter((f) => String(f.userId) === String(userId))
                    .sort((a, b) => b.id - a.id);
                if (cb) cb(null, rows);
                return;
            }

            if (/FROM custom_sources/i.test(q)) {
                const rows = [...state.custom_sources].sort((a, b) => b.id - a.id);
                if (cb) cb(null, rows);
                return;
            }

            if (/FROM disabled_sources/i.test(q)) {
                const rows = state.disabled_sources.map((s) => ({ sourceId: s }));
                if (cb) cb(null, rows);
                return;
            }

            if (cb) cb(null, []);
        }
    };
}

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({ name, address: iface.address });
            }
        }
    }
    // Ưu tiên card Wi-Fi hoặc Ethernet mạng LAN 192.168.x.x / 10.x.x.x
    const preferred = candidates.find(
        (c) => /wi-fi|wlan|ethernet/i.test(c.name) && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(c.address)
    );
    return (preferred && preferred.address) || (candidates[0] && candidates[0].address) || 'localhost';
}

const app = express();
const PORT = process.env.PORT || 3000;
const rssParser = new Parser({
    timeout: 7500,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    }
});

// Đảm bảo thư mục uploads tồn tại
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Middleware
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// Khởi tạo Database (Tự động dùng SQLite nếu tương thích, hoặc chuyển sang JSON Cloud DB trên Render Linux tránh lỗi GLIBC_2.38)
let db;
try {
    if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
        throw new Error('Sử dụng Cloud JSON Database trên Render Linux');
    }
    const sqlite3 = require('sqlite3').verbose();
    db = new sqlite3.Database(path.join(__dirname, 'thoisucuasang.db'), (err) => {
        if (err) {
            console.error('Lỗi kết nối SQLite:', err.message);
        } else {
            console.log('Đã kết nối SQLite Database thành công.');
        }
    });
} catch (err) {
    console.log('☁️ Đã kích hoạt Cloud JSON Database (Tương thích 100% Render Linux): thoisucuasang-data.json');
    db = createJsonCloudDatabase(path.join(__dirname, 'thoisucuasang-data.json'));
}

db.serialize(() => {
    // Bảng users
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )
    `);

    // Bảng files
    db.run(`
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER NOT NULL,
            originalName TEXT NOT NULL,
            filename TEXT NOT NULL,
            size INTEGER NOT NULL,
            uploadDate TEXT NOT NULL,
            FOREIGN KEY (userId) REFERENCES users(id)
        )
    `);

    // Bảng custom_sources (Lưu các trang báo do người dùng tự thêm bằng URL)
    db.run(`
        CREATE TABLE IF NOT EXISTS custom_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sourceId TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            siteUrl TEXT NOT NULL,
            rssUrl TEXT NOT NULL,
            mode TEXT DEFAULT 'rss',
            createdAt TEXT NOT NULL
        )
    `);

    // Bảng disabled_sources (Lưu các trang báo mặc định mà người dùng đã bấm xóa/ẩn)
    db.run(`
        CREATE TABLE IF NOT EXISTS disabled_sources (
            sourceId TEXT PRIMARY KEY
        )
    `);
});

// Cấu hình Multer lưu file vật lý vào thư mục uploads/
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 } // Giới hạn 50MB/file
});

// ==================== RESTful APIs ====================

// 1. Đăng ký tài khoản (/api/register)
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.trim() === '' || password.trim() === '') {
        return res.status(400).json({ error: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.' });
    }

    const cleanUser = username.trim();
    const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;
    db.run(sql, [cleanUser, password], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) {
                return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại!' });
            }
            return res.status(500).json({ error: 'Lỗi máy chủ khi đăng ký.' });
        }
        res.status(201).json({
            message: 'Đăng ký thành công!',
            userId: this.lastID,
            username: cleanUser
        });
    });
});

// 2. Đăng nhập (/api/login)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });
    }

    const sql = `SELECT id, username FROM users WHERE username = ? AND password = ?`;
    db.get(sql, [username.trim(), password], (err, row) => {
        if (err) {
            return res.status(500).json({ error: 'Lỗi truy vấn cơ sở dữ liệu.' });
        }
        if (!row) {
            return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu!' });
        }
        res.json({
            message: 'Đăng nhập thành công!',
            userId: row.id,
            username: row.username
        });
    });
});

// 3. Tải file lên (/api/upload)
app.post('/api/upload', upload.single('file'), (req, res) => {
    const userId = req.headers['x-user-id'] || req.body.userId;
    if (!userId) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(401).json({ error: 'Chưa xác thực người dùng (thiếu userId).' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'Không có file nào được chọn để tải lên.' });
    }

    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const filename = req.file.filename;
    const size = req.file.size;
    const uploadDate = new Date().toISOString();

    const sql = `INSERT INTO files (userId, originalName, filename, size, uploadDate) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [userId, originalName, filename, size, uploadDate], function (err) {
        if (err) {
            return res.status(500).json({ error: 'Không thể lưu thông tin file vào DB.' });
        }
        res.status(201).json({
            message: 'Tải file lên thành công!',
            file: {
                id: this.lastID,
                userId: Number(userId),
                originalName,
                filename,
                size,
                uploadDate
            }
        });
    });
});

// 4. Lấy danh sách file theo userId (GET /api/files)
app.get('/api/files', (req, res) => {
    const userId = req.headers['x-user-id'] || req.query.userId;
    if (!userId) {
        return res.status(401).json({ error: 'Vui lòng đăng nhập để xem danh sách file.' });
    }

    const sql = `SELECT * FROM files WHERE userId = ? ORDER BY id DESC`;
    db.all(sql, [userId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Lỗi khi lấy danh sách file.' });
        }
        res.json(rows);
    });
});

// 5. Xóa file vật lý và bản ghi trong DB (DELETE /api/files và DELETE /api/files/:id)
const deleteFileHandler = (req, res) => {
    const userId = req.headers['x-user-id'] || req.query.userId || (req.body && req.body.userId);
    const fileId = req.params.id || req.query.id || (req.body && req.body.id);

    if (!userId || !fileId) {
        return res.status(400).json({ error: 'Thiếu thông tin userId hoặc fileId cần xóa.' });
    }

    db.get(`SELECT * FROM files WHERE id = ? AND userId = ?`, [fileId, userId], (err, file) => {
        if (err) {
            return res.status(500).json({ error: 'Lỗi truy vấn file.' });
        }
        if (!file) {
            return res.status(404).json({ error: 'Không tìm thấy file hoặc bạn không có quyền xóa.' });
        }

        const filePath = path.join(uploadDir, file.filename);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (unlinkErr) {
                console.error('Không thể xóa file vật lý:', unlinkErr.message);
            }
        }

        db.run(`DELETE FROM files WHERE id = ? AND userId = ?`, [fileId, userId], function (delErr) {
            if (delErr) {
                return res.status(500).json({ error: 'Lỗi xóa bản ghi trong cơ sở dữ liệu.' });
            }
            res.json({ message: 'Đã xóa file thành công!', deletedId: Number(fileId) });
        });
    });
};

app.delete('/api/files/:id', deleteFileHandler);
app.delete('/api/files', deleteFileHandler);

// ==================== 6. API TIN TỨC 6 TRANG BÁO LỚN (/api/news) ====================
// 6 Trang báo tích hợp: VNExpress, Tuổi Trẻ, Thanh Niên, Dân Trí, VietNamNet, CafeF
const ALL_FEEDS = [
    // 1. VNExpress
    { url: 'https://vnexpress.net/rss/thoi-su.rss', sourceId: 'vnexpress', source: 'VNExpress', category: 'thoi-su', categoryLabel: 'Thời sự' },
    { url: 'https://vnexpress.net/rss/kinh-doanh.rss', sourceId: 'vnexpress', source: 'VNExpress', category: 'tai-chinh', categoryLabel: 'Tài chính - Kinh doanh' },
    { url: 'https://vnexpress.net/rss/the-gioi.rss', sourceId: 'vnexpress', source: 'VNExpress', category: 'chinh-tri', categoryLabel: 'Chính trị & Thế giới' },

    // 2. Tuổi Trẻ
    { url: 'https://tuoitre.vn/rss/thoi-su.rss', sourceId: 'tuoitre', source: 'Tuổi Trẻ', category: 'thoi-su', categoryLabel: 'Thời sự' },
    { url: 'https://tuoitre.vn/rss/kinh-doanh.rss', sourceId: 'tuoitre', source: 'Tuổi Trẻ', category: 'tai-chinh', categoryLabel: 'Tài chính - Kinh doanh' },
    { url: 'https://tuoitre.vn/rss/the-gioi.rss', sourceId: 'tuoitre', source: 'Tuổi Trẻ', category: 'chinh-tri', categoryLabel: 'Chính trị & Thế giới' },

    // 3. Thanh Niên
    { url: 'https://thanhnien.vn/rss/thoi-su.rss', sourceId: 'thanhnien', source: 'Thanh Niên', category: 'thoi-su', categoryLabel: 'Thời sự' },
    { url: 'https://thanhnien.vn/rss/kinh-te.rss', sourceId: 'thanhnien', source: 'Thanh Niên', category: 'tai-chinh', categoryLabel: 'Tài chính - Kinh tế' },
    { url: 'https://thanhnien.vn/rss/the-gioi.rss', sourceId: 'thanhnien', source: 'Thanh Niên', category: 'chinh-tri', categoryLabel: 'Chính trị & Thế giới' },

    // 4. Dân Trí
    { url: 'https://dantri.com.vn/rss/su-kien.rss', sourceId: 'dantri', source: 'Dân Trí', category: 'thoi-su', categoryLabel: 'Sự kiện & Thời sự' },
    { url: 'https://dantri.com.vn/rss/kinh-doanh.rss', sourceId: 'dantri', source: 'Dân Trí', category: 'tai-chinh', categoryLabel: 'Tài chính - Kinh doanh' },
    { url: 'https://dantri.com.vn/rss/the-gioi.rss', sourceId: 'dantri', source: 'Dân Trí', category: 'chinh-tri', categoryLabel: 'Chính trị & Thế giới' },

    // 5. VietNamNet
    { url: 'https://vietnamnet.vn/rss/thoi-su.rss', sourceId: 'vietnamnet', source: 'VietNamNet', category: 'thoi-su', categoryLabel: 'Thời sự' },
    { url: 'https://vietnamnet.vn/rss/chinh-tri.rss', sourceId: 'vietnamnet', source: 'VietNamNet', category: 'chinh-tri', categoryLabel: 'Chính trị Việt Nam' },
    { url: 'https://vietnamnet.vn/rss/kinh-doanh.rss', sourceId: 'vietnamnet', source: 'VietNamNet', category: 'tai-chinh', categoryLabel: 'Tài chính - Kinh doanh' },
    { url: 'https://vietnamnet.vn/rss/the-gioi.rss', sourceId: 'vietnamnet', source: 'VietNamNet', category: 'chinh-tri', categoryLabel: 'Chính trị & Thế giới' },

    // 6. CafeF (Chuyên trang Tài chính - Chứng khoán - Vĩ mô)
    { url: 'https://cafef.vn/tai-chinh-ngan-hang.rss', sourceId: 'cafef', source: 'CafeF', category: 'tai-chinh', categoryLabel: 'Tài chính - Ngân hàng' },
    { url: 'https://cafef.vn/thi-truong-chung-khoan.rss', sourceId: 'cafef', source: 'CafeF', category: 'tai-chinh', categoryLabel: 'Chứng khoán' },
    { url: 'https://cafef.vn/vi-mo-dau-tu.rss', sourceId: 'cafef', source: 'CafeF', category: 'thoi-su', categoryLabel: 'Vĩ mô & Đầu tư' }
];

const WEATHER_KEYWORDS = [
    'thời tiết', 'mưa', 'bão', 'áp thấp', 'không khí lạnh', 'nắng nóng', 'nhiệt độ',
    'lũ', 'ngập', 'triều cường', 'rét', 'gió mùa', 'dự báo', 'khí tượng', 'sạt lở', 'nắng'
];

function decodeHtmlEntities(str) {
    if (!str) return '';
    const namedEntities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
        '&aacute;': 'á', '&agrave;': 'à', '&atilde;': 'ã', '&acirc;': 'â',
        '&Aacute;': 'Á', '&Agrave;': 'À', '&Atilde;': 'Ã', '&Acirc;': 'Â',
        '&eacute;': 'é', '&egrave;': 'è', '&etilde;': 'ẽ', '&ecirc;': 'ê',
        '&Eacute;': 'É', '&Egrave;': 'È', '&Etilde;': 'Ẽ', '&Ecirc;': 'Ê',
        '&iacute;': 'í', '&igrave;': 'ì', '&itilde;': 'ĩ', '&icirc;': 'î',
        '&Iacute;': 'Í', '&Igrave;': 'Ì', '&Itilde;': 'Ĩ', '&Icirc;': 'Î',
        '&oacute;': 'ó', '&ograve;': 'ò', '&otilde;': 'õ', '&ocirc;': 'ô',
        '&Oacute;': 'Ó', '&Ograve;': 'Ò', '&Otilde;': 'Õ', '&Ocirc;': 'Ô',
        '&uacute;': 'ú', '&ugrave;': 'ù', '&utilde;': 'ũ', '&ucirc;': 'û',
        '&Uacute;': 'Ú', '&Ugrave;': 'Ù', '&Utilde;': 'Ũ', '&Ucirc;': 'Û',
        '&yacute;': 'ý', '&ygrave;': 'ỳ', '&ytilde;': 'ỹ',
        '&Yacute;': 'Ý', '&Ygrave;': 'Ỳ', '&Ytilde;': 'Ỹ'
    };
    return str
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&[a-zA-Z0-9#]+;/g, (match) => namedEntities[match] || match);
}

function formatRssItem(item, feedCfg) {
    const rawSnippet = item.contentSnippet || item.content || '';
    const cleanSnippet = decodeHtmlEntities(rawSnippet.replace(/<[^>]*>?/gm, '')).trim();
    const cleanTitle = decodeHtmlEntities(item.title ? item.title.trim() : 'Bản tin mới');
    return {
        title: cleanTitle,
        link: item.link,
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        sourceId: feedCfg.sourceId,
        source: feedCfg.source,
        category: feedCfg.categoryLabel,
        snippet: cleanSnippet
            ? cleanSnippet.slice(0, 150) + (cleanSnippet.length > 150 ? '...' : '')
            : `Nhấn vào để đọc chi tiết trên báo ${feedCfg.source}.`
    };
}

const BUILTIN_SOURCES = [
    { sourceId: 'vnexpress', name: 'VNExpress', fullName: 'Báo VNExpress', dotClass: 'dot-vnexpress', isBuiltin: true },
    { sourceId: 'tuoitre', name: 'Tuổi Trẻ', fullName: 'Báo Tuổi Trẻ', dotClass: 'dot-tuoitre', isBuiltin: true },
    { sourceId: 'thanhnien', name: 'Thanh Niên', fullName: 'Báo Thanh Niên', dotClass: 'dot-thanhnien', isBuiltin: true },
    { sourceId: 'dantri', name: 'Dân Trí', fullName: 'Báo Dân Trí', dotClass: 'dot-dantri', isBuiltin: true },
    { sourceId: 'vietnamnet', name: 'VietNamNet', fullName: 'Báo VietNamNet', dotClass: 'dot-vietnamnet', isBuiltin: true },
    { sourceId: 'cafef', name: 'CafeF', fullName: 'Tài chính CafeF', dotClass: 'dot-cafef', isBuiltin: true }
];

// Hàm đọc danh sách trang báo tùy chỉnh từ SQLite
function getCustomSourcesFromDb() {
    return new Promise((resolve) => {
        db.all(`SELECT * FROM custom_sources ORDER BY id DESC`, [], (err, rows) => {
            if (err || !rows) return resolve([]);
            resolve(rows);
        });
    });
}

// Hàm đọc danh sách các báo mặc định đã bị người dùng xóa/ẩn
function getDisabledBuiltinSet() {
    return new Promise((resolve) => {
        db.all(`SELECT sourceId FROM disabled_sources`, [], (err, rows) => {
            if (err || !rows) return resolve(new Set());
            resolve(new Set(rows.map((r) => r.sourceId.toLowerCase())));
        });
    });
}

// Trích xuất bài báo trực tiếp từ HTML nếu trang báo không có RSS Feed
function extractArticlesFromHtml(html, baseUrl, feedCfg) {
    const items = [];
    const seenLinks = new Set();
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorRegex.exec(html)) !== null && items.length < 15) {
        const rawHref = match[1].trim();
        const innerText = decodeHtmlEntities(match[2].replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ')).trim();

        // Lọc các tiêu đề bài báo thực sự (độ dài hợp lý, không phải menu ngắn)
        if (innerText.length < 28 || innerText.length > 220) continue;
        if (/^(trang chủ|đăng nhập|liên hệ|quảng cáo|chính sách|điều khoản)/i.test(innerText)) continue;

        let fullUrl = '';
        try {
            fullUrl = new URL(rawHref, baseUrl).href;
        } catch (_) {
            continue;
        }

        if (!fullUrl.startsWith('http') || seenLinks.has(fullUrl)) continue;
        // Ưu tiên link bài viết có đường dẫn chi tiết
        const pathPart = new URL(fullUrl).pathname;
        if (pathPart.length < 12 || pathPart === '/') continue;

        seenLinks.add(fullUrl);
        items.push({
            title: innerText,
            link: fullUrl,
            pubDate: new Date().toISOString(),
            sourceId: feedCfg.sourceId,
            source: feedCfg.source,
            category: feedCfg.categoryLabel || 'Tin mới tự động',
            snippet: `Bài viết trích xuất tự động từ trang báo ${feedCfg.source}. Nhấn vào tiêu đề để đọc toàn văn.`
        });
    }
    return items;
}

const KNOWN_DOMAIN_RSS = {
    'vtv.vn': 'https://vtv.vn/trong-nuoc.rss',
    'tienphong.vn': 'https://tienphong.vn/rss/home.rss',
    'nld.com.vn': 'https://nld.com.vn/rss/home.rss',
    'soha.vn': 'https://soha.vn/rss/home.rss',
    'kenh14.vn': 'https://kenh14.vn/rss/home.rss',
    'genk.vn': 'https://genk.vn/rss/home.rss',
    'vov.vn': 'https://vov.vn/rss/chinh-tri-209.rss',
    'vnexpress.net': 'https://vnexpress.net/rss/tin-moi-nhat.rss',
    'tuoitre.vn': 'https://tuoitre.vn/rss/tin-moi-nhat.rss',
    'thanhnien.vn': 'https://thanhnien.vn/rss/home.rss',
    'dantri.com.vn': 'https://dantri.com.vn/rss/home.rss',
    'vietnamnet.vn': 'https://vietnamnet.vn/rss/tin-moi-nhat.rss',
    'cafef.vn': 'https://cafef.vn/thi-truong-chung-khoan.rss'
};

// Tự động dò tìm RSS / API tin tức khi người dùng nhập địa chỉ trang báo bất kỳ
async function discoverNewsFeed(rawUrl, customName = '') {
    let normalizedUrl = rawUrl.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
        normalizedUrl = 'https://' + normalizedUrl;
    }

    const parsedUrl = new URL(normalizedUrl);
    const origin = parsedUrl.origin;
    const hostname = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();
    const defaultName = customName.trim() || hostname.split('.')[0].toUpperCase();

    // Bước 1: Kiểm tra xem địa chỉ người dùng nhập có phải là link RSS trực tiếp hoặc tên miền đã biết không
    const directCandidates = [normalizedUrl];
    if (KNOWN_DOMAIN_RSS[hostname]) {
        directCandidates.unshift(KNOWN_DOMAIN_RSS[hostname]);
    }

    for (const directUrl of directCandidates) {
        try {
            const directFeed = await rssParser.parseURL(directUrl);
            if (directFeed && directFeed.items && directFeed.items.length > 0) {
                return {
                    name: customName.trim() || defaultName,
                    siteUrl: origin,
                    rssUrl: directUrl,
                    mode: 'rss',
                    sampleCount: directFeed.items.length,
                    sampleTitle: decodeHtmlEntities(directFeed.items[0].title || '')
                };
            }
        } catch (_) {}
    }

    // Bước 2: Tải HTML trang báo để tìm thẻ <link type="application/rss+xml"> hoặc đường dẫn .rss
    let htmlContent = '';
    const candidateRssUrls = new Set();

    try {
        const res = await fetch(normalizedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(6500)
        });
        if (res.ok) {
            htmlContent = await res.text();

            // 2a. Tìm <link rel="alternate" type="application/rss+xml" href="...">
            const linkTagRegex = /<link\b[^>]*type=["']application\/(rss|atom)\+xml["'][^>]*>/gi;
            let linkMatch;
            while ((linkMatch = linkTagRegex.exec(htmlContent)) !== null) {
                const hrefMatch = linkMatch[0].match(/href=["']([^"']+)["']/i);
                if (hrefMatch && hrefMatch[1]) {
                    try {
                        candidateRssUrls.add(new URL(hrefMatch[1], origin).href);
                    } catch (_) {}
                }
            }

            // 2b. Tìm các thẻ <a href="..."> chứa .rss hoặc /rss/ trên trang
            const aRssRegex = /href=["']([^"']*(?:\.rss|\/rss\/[^"']+|\/feed\/?)[^"']*)["']/gi;
            let aMatch;
            while ((aMatch = aRssRegex.exec(htmlContent)) !== null && candidateRssUrls.size < 8) {
                try {
                    const resolved = new URL(aMatch[1], origin).href;
                    if (resolved.startsWith(origin)) candidateRssUrls.add(resolved);
                } catch (_) {}
            }
        }
    } catch (_) {}

    // Bước 3: Bổ sung các cấu trúc đường dẫn RSS phổ biến của các báo điện tử Việt Nam & Quốc tế
    const commonPaths = [
        '/rss/home.rss',
        '/rss/tin-moi-nhat.rss',
        '/rss/tin-moi.rss',
        '/rss/thoi-su.rss',
        '/trong-nuoc.rss',
        '/tin-moi-nhat.rss',
        '/trang-chu.rss',
        '/rss.xml',
        '/feed'
    ];
    commonPaths.forEach((p) => candidateRssUrls.add(origin + p));

    const candidatesArray = Array.from(candidateRssUrls).slice(0, 10);
    const probeResults = await Promise.allSettled(
        candidatesArray.map(async (candidateUrl) => {
            const feed = await rssParser.parseURL(candidateUrl);
            if (feed && feed.items && feed.items.length > 0) {
                return { candidateUrl, feed };
            }
            throw new Error('Empty feed');
        })
    );

    const validRss = probeResults.find((r) => r.status === 'fulfilled');
    if (validRss) {
        const { candidateUrl, feed } = validRss.value;
        return {
            name: customName.trim() || defaultName,
            siteUrl: normalizedUrl,
            rssUrl: candidateUrl,
            mode: 'rss',
            sampleCount: feed.items.length,
            sampleTitle: decodeHtmlEntities(feed.items[0].title || '')
        };
    }

    // Bước 4: Cầu nối Universal Google News RSS theo tên miền (hoạt động cho 100% báo điện tử kể cả khi chặn Cloudflare)
    try {
        const googleBridgeUrl = `https://news.google.com/rss/search?q=site:${encodeURIComponent(hostname)}&hl=vi&gl=VN&ceid=VN:vi`;
        const bridgeFeed = await rssParser.parseURL(googleBridgeUrl);
        if (bridgeFeed && bridgeFeed.items && bridgeFeed.items.length > 0) {
            return {
                name: customName.trim() || defaultName,
                siteUrl: normalizedUrl,
                rssUrl: googleBridgeUrl,
                mode: 'rss',
                sampleCount: bridgeFeed.items.length,
                sampleTitle: decodeHtmlEntities(bridgeFeed.items[0].title || '')
            };
        }
    } catch (_) {}

    // Bước 5: Trích xuất bài viết trực tiếp từ HTML nếu có
    if (htmlContent) {
        const dummyCfg = { sourceId: 'preview', source: defaultName, categoryLabel: 'Tin mới' };
        const extracted = extractArticlesFromHtml(htmlContent, normalizedUrl, dummyCfg);
        if (extracted.length > 0) {
            return {
                name: defaultName,
                siteUrl: normalizedUrl,
                rssUrl: normalizedUrl,
                mode: 'html',
                sampleCount: extracted.length,
                sampleTitle: extracted[0].title
            };
        }
    }

    throw new Error('Không tìm thấy luồng tin tức RSS hoặc bài viết hợp lệ từ địa chỉ này.');
}

// API Quản lý Nguồn báo (cả 6 báo gốc và báo tùy chỉnh) (/api/sources)
app.get('/api/sources', async (req, res) => {
    const [customRows, disabledSet] = await Promise.all([
        getCustomSourcesFromDb(),
        getDisabledBuiltinSet()
    ]);

    const activeBuiltins = BUILTIN_SOURCES.filter((b) => !disabledSet.has(b.sourceId));
    const formattedCustom = customRows.map((c) => ({
        id: c.id,
        sourceId: c.sourceId,
        name: c.name,
        fullName: c.name,
        siteUrl: c.siteUrl,
        rssUrl: c.rssUrl,
        mode: c.mode,
        dotClass: 'dot-custom',
        isBuiltin: false
    }));

    res.json({
        sources: [...activeBuiltins, ...formattedCustom],
        disabledBuiltinCount: disabledSet.size
    });
});

app.post('/api/sources/restore-defaults', (req, res) => {
    db.run(`DELETE FROM disabled_sources`, [], function (err) {
        if (err) {
            return res.status(500).json({ error: 'Không thể khôi phục các trang báo mặc định.' });
        }
        res.json({ message: 'Đã khôi phục đầy đủ 6 trang báo gốc!' });
    });
});

app.post('/api/sources', async (req, res) => {
    const { url, name } = req.body;
    if (!url || !url.trim()) {
        return res.status(400).json({ error: 'Vui lòng nhập địa chỉ website trang báo (VD: https://laodong.vn).' });
    }

    try {
        const discovered = await discoverNewsFeed(url, name || '');
        const sourceId = 'custom_' + Date.now();
        const createdAt = new Date().toISOString();

        const sql = `INSERT INTO custom_sources (sourceId, name, siteUrl, rssUrl, mode, createdAt) VALUES (?, ?, ?, ?, ?, ?)`;
        db.run(
            sql,
            [sourceId, discovered.name, discovered.siteUrl, discovered.rssUrl, discovered.mode, createdAt],
            function (err) {
                if (err) {
                    return res.status(500).json({ error: 'Không thể lưu trang báo vào cơ sở dữ liệu.' });
                }
                res.status(201).json({
                    message: `Đã tự động kết nối nguồn báo "${discovered.name}" thành công!`,
                    source: {
                        id: this.lastID,
                        sourceId,
                        name: discovered.name,
                        siteUrl: discovered.siteUrl,
                        rssUrl: discovered.rssUrl,
                        mode: discovered.mode,
                        sampleCount: discovered.sampleCount,
                        sampleTitle: discovered.sampleTitle,
                        createdAt
                    }
                });
            }
        );
    } catch (err) {
        res.status(400).json({ error: err.message || 'Không thể tự động lấy API/RSS từ địa chỉ này.' });
    }
});

app.delete('/api/sources/:id', (req, res) => {
    const idOrSourceId = String(req.params.id).trim();
    const lowerId = idOrSourceId.toLowerCase();

    // Kiểm tra xem có phải xóa 1 trong 6 trang báo mặc định không
    const builtinMatch = BUILTIN_SOURCES.find((b) => b.sourceId === lowerId);
    if (builtinMatch) {
        db.run(`INSERT OR IGNORE INTO disabled_sources (sourceId) VALUES (?)`, [lowerId], function (err) {
            if (err) {
                return res.status(500).json({ error: 'Lỗi khi xóa trang báo mặc định.' });
            }
            return res.json({
                message: `Đã xóa báo "${builtinMatch.name}" khỏi danh sách theo dõi!`,
                deletedSourceId: lowerId
            });
        });
        return;
    }

    // Xóa trang báo tùy chỉnh
    db.run(
        `DELETE FROM custom_sources WHERE id = ? OR sourceId = ?`,
        [idOrSourceId, idOrSourceId],
        function (err) {
            if (err) {
                return res.status(500).json({ error: 'Lỗi khi xóa nguồn báo.' });
            }
            res.json({ message: 'Đã xóa trang báo khỏi danh sách theo dõi!', deletedSourceId: idOrSourceId });
        }
    );
});

async function fetchItemsFromFeedConfig(feedCfg) {
    if (feedCfg.mode === 'html') {
        const res = await fetch(feedCfg.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ThoiSuCuaSang/3.0' },
            signal: AbortSignal.timeout(7000)
        });
        if (!res.ok) throw new Error('HTML fetch failed');
        const html = await res.text();
        return extractArticlesFromHtml(html, feedCfg.url, feedCfg);
    } else {
        const parsed = await rssParser.parseURL(feedCfg.url);
        return (parsed.items || []).slice(0, 12).map((item) => formatRssItem(item, feedCfg));
    }
}

app.get('/api/news', async (req, res) => {
    const category = (req.query.category || 'all').toLowerCase();
    const source = (req.query.source || 'all').toLowerCase();
    const limit = Math.min(18, Math.max(5, parseInt(req.query.limit, 10) || 8));

    // Kết hợp các trang báo mặc định (chưa bị xóa) + các trang báo người dùng tự thêm
    const [customRows, disabledSet] = await Promise.all([
        getCustomSourcesFromDb(),
        getDisabledBuiltinSet()
    ]);

    const activeBuiltinFeeds = ALL_FEEDS.filter((f) => !disabledSet.has(f.sourceId.toLowerCase()));
    const customFeeds = customRows.map((row) => ({
        url: row.rssUrl,
        sourceId: row.sourceId,
        source: row.name,
        category: 'thoi-su',
        categoryLabel: row.mode === 'rss' ? 'RSS Tự động' : 'Trích xuất Web',
        mode: row.mode || 'rss'
    }));

    let selectedFeeds = [...customFeeds, ...activeBuiltinFeeds];

    // Lọc theo trang báo (source)
    if (source !== 'all') {
        selectedFeeds = selectedFeeds.filter((f) => f.sourceId.toLowerCase() === source);
    } else {
        // Khi chọn Tất cả: Lọc theo chuyên mục cho các báo mặc định, nhưng luôn giữ các báo tùy chỉnh khi xem Thời sự / Tổng hợp
        if (category === 'thoi-tiet') {
            const weatherFeeds = selectedFeeds.filter((f) => f.category === 'thoi-su');
            if (weatherFeeds.length > 0) selectedFeeds = weatherFeeds;
        } else if (category !== 'all') {
            const catFeeds = selectedFeeds.filter(
                (f) => f.category === category || (category === 'thoi-su' && f.sourceId.startsWith('custom_'))
            );
            if (catFeeds.length > 0) selectedFeeds = catFeeds;
        }
    }

    // Giới hạn tối đa 7 luồng mỗi lần gọi để phản hồi nhanh
    selectedFeeds = selectedFeeds.slice(0, 7);

    try {
        const feedResults = await Promise.allSettled(
            selectedFeeds.map((feedCfg) => fetchItemsFromFeedConfig(feedCfg))
        );

        // Đan xen (Interleave) tin từ các báo để danh sách hiển thị đa dạng mọi tờ báo
        const buckets = feedResults
            .filter((r) => r.status === 'fulfilled' && r.value.length > 0)
            .map((r) => r.value);

        let allItems = [];
        const maxLen = Math.max(0, ...buckets.map((b) => b.length));
        for (let i = 0; i < maxLen; i++) {
            for (const bucket of buckets) {
                if (bucket[i]) allItems.push(bucket[i]);
            }
        }

        // Nếu chọn chuyên mục Thời tiết thì ưu tiên các bài có từ khóa thời tiết/mưa bão
        if (category === 'thoi-tiet') {
            const matched = allItems.filter((item) => {
                const text = `${item.title} ${item.snippet}`.toLowerCase();
                return WEATHER_KEYWORDS.some((kw) => text.includes(kw));
            });
            if (matched.length >= 2) {
                allItems = matched.map((m) => ({ ...m, category: 'Thời tiết & Khí hậu' }));
            }
        }

        // Khử trùng lặp tiêu đề
        const seenTitles = new Set();
        const uniqueItems = [];
        for (const item of allItems) {
            if (!seenTitles.has(item.title)) {
                seenTitles.add(item.title);
                uniqueItems.push(item);
            }
        }

        res.json(uniqueItems.slice(0, limit));
    } catch (error) {
        console.error('Lỗi đọc RSS:', error.message);
        res.status(500).json({ error: 'Không thể tải tin tức RSS lúc này.' });
    }
});

// ==================== 7. API THỜI TIẾT TRỰC TUYẾN (/api/weather) ====================
const VIETNAM_CITIES = [
    { id: 'hanoi', name: 'Hà Nội', region: 'Miền Bắc', lat: 21.0285, lon: 105.8542 },
    { id: 'hcm', name: 'TP. Hồ Chí Minh', region: 'Miền Nam', lat: 10.8231, lon: 106.6297 },
    { id: 'danang', name: 'Đà Nẵng', region: 'Miền Trung', lat: 16.0544, lon: 108.2022 },
    { id: 'haiphong', name: 'Hải Phòng', region: 'Miền Bắc', lat: 20.8449, lon: 106.6881 },
    { id: 'cantho', name: 'Cần Thơ', region: 'Miền Tây', lat: 10.0452, lon: 105.7469 }
];

function decodeWeatherCode(code) {
    const map = {
        0: { desc: 'Trời quang đãng', icon: '☀️' },
        1: { desc: 'Nắng nhẹ, ít mây', icon: '🌤️' },
        2: { desc: 'Có mây rải rác', icon: '⛅' },
        3: { desc: 'Nhiều mây âm u', icon: '☁️' },
        45: { desc: 'Có sương mù', icon: '🌫️' },
        48: { desc: 'Sương mù dày', icon: '🌫️' },
        51: { desc: 'Mưa phùn nhẹ', icon: '🌦️' },
        53: { desc: 'Mưa phùn vừa', icon: '🌦️' },
        55: { desc: 'Mưa phùn dày', icon: '🌧️' },
        61: { desc: 'Mưa rào nhẹ', icon: '🌦️' },
        63: { desc: 'Mưa vừa', icon: '🌧️' },
        65: { desc: 'Mưa to', icon: '⛈️' },
        80: { desc: 'Mưa rào rải rác', icon: '🌦️' },
        81: { desc: 'Mưa rào nặng hạt', icon: '🌧️' },
        82: { desc: 'Mưa giông lớn', icon: '⛈️' },
        95: { desc: 'Giông bão có sấm sét', icon: '🌩️' },
        96: { desc: 'Giông kèm mưa lớn', icon: '⛈️' }
    };
    return map[code] || { desc: 'Thời tiết ổn định', icon: '🌤️' };
}

app.get('/api/weather', async (req, res) => {
    try {
        const lats = VIETNAM_CITIES.map((c) => c.lat).join(',');
        const lons = VIETNAM_CITIES.map((c) => c.lon).join(',');
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FHo_Chi_Minh&forecast_days=1`;

        const response = await fetch(url);
        if (!response.ok) throw new Error('Open-Meteo API trả về lỗi');
        const rawData = await response.json();
        const dataList = Array.isArray(rawData) ? rawData : [rawData];

        const weatherCities = VIETNAM_CITIES.map((city, idx) => {
            const d = dataList[idx] || {};
            const current = d.current || {};
            const daily = d.daily || {};
            const wInfo = decodeWeatherCode(current.weather_code);
            return {
                id: city.id,
                name: city.name,
                region: city.region,
                temp: Math.round(current.temperature_2m ?? 28),
                feelsLike: Math.round(current.apparent_temperature ?? 30),
                humidity: current.relative_humidity_2m ?? 75,
                windSpeed: current.wind_speed_10m ?? 10,
                maxTemp: Math.round(daily.temperature_2m_max?.[0] ?? 32),
                minTemp: Math.round(daily.temperature_2m_min?.[0] ?? 24),
                description: wInfo.desc,
                icon: wInfo.icon
            };
        });

        res.json({
            updatedAt: new Date().toISOString(),
            source: 'Open-Meteo Weather Network',
            cities: weatherCities
        });
    } catch (err) {
        console.error('Lỗi lấy dữ liệu thời tiết:', err.message);
        res.status(500).json({ error: 'Không thể tải dữ liệu thời tiết lúc này.' });
    }
});

// ==================== 8. API THÔNG TIN CÀI ĐẶT APP ĐIỆN THOẠI & HỖ TRỢ CLOUD (RENDER / HTTPS) ====================
let publicHttpsUrl = process.env.RENDER_EXTERNAL_URL || null;

function startCloudflareHttpsTunnel() {
    // Nếu đang chạy trên Cloud (Render.com) thì đã có sẵn tên miền HTTPS vĩnh viễn, không cần mở tunnel
    if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL || process.env.NODE_ENV === 'production') {
        return;
    }
    try {
        const { Tunnel } = require('cloudflared');
        const cfTunnel = Tunnel.quick(`http://127.0.0.1:${PORT}`);
        cfTunnel.on('url', (url) => {
            publicHttpsUrl = url;
            console.log(`🔒 Đường truyền HTTPS cài App toàn cầu (Wi-Fi & 4G/5G): ${publicHttpsUrl}`);
        });
        cfTunnel.on('error', (err) => {
            console.warn('⚠️ Cloudflare Tunnel:', err.message);
        });
    } catch (_) {
        // Bỏ qua nếu môi trường không cài cloudflared
    }
}

app.get('/api/app-info', (req, res) => {
    const ip = getLocalIpAddress();
    const lanUrl = `http://${ip}:${PORT}`;
    const host = req.get('host') || '';
    const isCloudHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' || Boolean(process.env.RENDER_EXTERNAL_URL);
    const detectedHttpsUrl = process.env.RENDER_EXTERNAL_URL || (isCloudHttps && host ? `https://${host}` : publicHttpsUrl);

    res.json({
        appName: 'Thời Sự Của Sang',
        version: '3.5 PWA Cloud Online',
        ip,
        port: PORT,
        lanUrl: detectedHttpsUrl || lanUrl,
        httpsUrl: detectedHttpsUrl,
        installUrl: detectedHttpsUrl || lanUrl
    });
});

// Khởi động Server (Hỗ trợ cả Render Cloud lẫn Localhost)
app.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIpAddress();
    console.log(`🚀 Server "Thời Sự Của Sang" đang chạy tại cổng: ${PORT}`);
    if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`🌐 Địa chỉ Online Render: ${process.env.RENDER_EXTERNAL_URL}`);
    } else {
        console.log(`💻 Localhost: http://localhost:${PORT}`);
        console.log(`📱 Điện thoại (cùng Wi-Fi): http://${ip}:${PORT}`);
        startCloudflareHttpsTunnel();
    }
});
