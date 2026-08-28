const jwt = require('jsonwebtoken');

// ตรวจสอบ JWT ที่ส่งมาใน header: Authorization: Bearer <token>
// ใช้ป้องกัน endpoint ฝั่งแอดมินทั้งหมด แทนการเช็ค prompt() รหัสผ่านที่ฝั่ง client แบบเดิม
function requireAdmin(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบแอดมินก่อน' });
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.admin = payload; // { sub, username }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });
    }
}

module.exports = { requireAdmin };
