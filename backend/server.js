require('dotenv').config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET') {
    console.error('❌ กรุณาตั้งค่า JWT_SECRET ในไฟล์ .env ให้เป็นค่าสุ่มที่ปลอดภัยก่อนรันระบบ');
    process.exit(1);
}

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDatabase } = require('./db/database');

const authRoutes = require('./routes/auth.routes');
const layoutRoutes = require('./routes/layout.routes');
const bookingRoutes = require('./routes/booking.routes');
const settingsRoutes = require('./routes/settings.routes');
// 🟢 1. เพิ่มการ Import content.routes
const contentRoutes = require('./routes/content.routes');

const app = express();

app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' } // ให้ frontend คนละ origin โหลดรูปสลิป/รูปเมนูได้
}));
app.use(cors({
    origin: process.env.FRONTEND_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
}));
app.use(express.json({ limit: '1mb' }));

// จำกัด request รวมทั้งระบบกันโดน spam/DoS แบบง่ายๆ
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// เสิร์ฟไฟล์รูปที่อัปโหลด (สลิปโอนเงิน / รูปเมนูอาหาร)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/layout', layoutRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/settings', settingsRoutes);
// 🟢 2. เปิดใช้งาน Route /api/content
app.use('/api/content', contentRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// error handler กลาง กันหลุด stack trace ไปให้ client เห็น
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
});

const PORT = process.env.PORT || 3000;

// 🟢 เชื่อมต่อ + เตรียมฐานข้อมูล Turso ให้เสร็จก่อน แล้วค่อยเปิดรับ request
// (ต่างจากเดิมที่ใช้ SQLite ไฟล์ในเครื่อง ซึ่งพร้อมใช้งานทันทีแบบ synchronous)
initDatabase()
    .then(() => {
        app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
    })
    .catch(err => {
        console.error('❌ เชื่อมต่อฐานข้อมูล Turso ไม่สำเร็จ:', err.message);
        console.error('   ตรวจสอบว่าตั้งค่า TURSO_DATABASE_URL และ TURSO_AUTH_TOKEN ใน .env ถูกต้องหรือไม่');
        process.exit(1);
    });
    module.exports = app;