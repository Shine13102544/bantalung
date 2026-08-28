const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// ต้องตั้งค่า 3 ตัวนี้ใน .env (สมัครฟรีที่ cloudinary.com แล้วคัดลอกมาจากหน้า Dashboard)
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('ไม่พบค่า CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET ใน .env กรุณาตั้งค่าก่อนรันเซิร์ฟเวอร์ (ดูวิธีได้ที่ cloudinary.com)');
}

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// สร้าง storage engine แยกโฟลเดอร์ตามประเภทไฟล์ ให้จัดการง่ายในหน้า Cloudinary Dashboard
function makeStorage(folder) {
    return new CloudinaryStorage({
        cloudinary,
        params: {
            folder: `bantalung/${folder}`,
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            transformation: [{ quality: 'auto' }] // ลดขนาดไฟล์อัตโนมัติ ไม่กระทบคุณภาพที่ตาเห็น
        }
    });
}

module.exports = { cloudinary, makeStorage };
