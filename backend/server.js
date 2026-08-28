require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 🟢 แก้ไข Path การอ้างอิงไฟล์ db (ปรับให้ตรงตามโครงสร้างไฟล์ของคุณ เช่น ./db หรือ ../db)
let initDatabase;
try {
    initDatabase = require('./db').initDatabase;
} catch (e) {
    initDatabase = require('./db/database').initDatabase;
}

const authRoutes = require('./routes/auth.routes');
const layoutRoutes = require('./routes/layout.routes');
const bookingRoutes = require('./routes/booking.routes');
const settingsRoutes = require('./routes/settings.routes');
const contentRoutes = require('./routes/content.routes');

const app = express();

app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
    origin: process.env.FRONTEND_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
}));

app.use(express.json({ limit: '1mb' }));

app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// Middleware ตรวจสอบและรันการเริ่มสร้างฐานข้อมูล Turso ก่อนรับ Request เสมอ
let isDbReady = false;
let dbInitPromise = null;

app.use(async (req, res, next) => {
    if (!isDbReady) {
        try {
            if (!dbInitPromise) {
                dbInitPromise = initDatabase();
            }
            await dbInitPromise;
            isDbReady = true;
        } catch (err) {
            console.error('❌ DB Init Error:', err.message);
            return res.status(500).json({ error: 'Database Connection Error: ' + err.message });
        }
    }
    next();
});

// เสิร์ฟไฟล์อัปโหลด
app.use('/uploads', express.static(path.join(process.cwd(), 'backend/uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/layout', layoutRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/content', contentRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Centralized error handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
}

module.exports = app;