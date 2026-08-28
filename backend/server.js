require('dotenv').config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET') {
    console.error('❌ กรุณาตั้งค่า JWT_SECRET ในไฟล์ .env ให้เป็นค่าสุ่มที่ปลอดภัยก่อนรันระบบ');
    // ลบ process.exit(1) ออกเพื่อป้องกัน Serverless ค้างพัง
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

// 🟢 เรียกเชื่อมต่อฐานข้อมูล Turso แบบไม่บล็อก Vercel Serverless
initDatabase().catch(err => {
    console.error('❌ เชื่อมต่อฐานข้อมูล Turso ไม่สำเร็จ:', err.message);
    console.error('   ตรวจสอบว่าตั้งค่า TURSO_DATABASE_URL และ TURSO_AUTH_TOKEN ใน .env ถูกต้องหรือไม่');
});

// 🟢 หากรันในเครื่อง (Local) ให้สั่งเปิด Port 3000 ตามปกติ
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
}

module.exports = app;