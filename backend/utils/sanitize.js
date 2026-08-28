const sanitizeHtml = require('sanitize-html');

// ใช้กับข้อมูลที่ผู้ใช้กรอกทุกจุดก่อนบันทึกลง DB (ชื่อ, เบอร์โทร, ข้อความป้าย ฯลฯ)
// ตัด tag/attribute อันตรายทั้งหมดออก เหลือแค่ plain text
function clean(input) {
    if (typeof input !== 'string') return input;
    return sanitizeHtml(input.trim(), { allowedTags: [], allowedAttributes: {} }).slice(0, 500);
}

module.exports = { clean };
