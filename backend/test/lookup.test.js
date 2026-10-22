// ทดสอบการค้นหา "ดูบัตรของฉัน": ชื่อที่ตาเห็นว่าเหมือนกันต้องเทียบผ่าน (สระอำ, ช่องว่างล่องหน, คำนำหน้า ฯลฯ)
// แต่ชื่อที่ต่างกันจริง/เบอร์ไม่ตรง ต้องไม่ผ่าน
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupEnv, stubCloudinary } = require('./helpers');

setupEnv();
stubCloudinary();
const { initDatabase, dbRun } = require('../db/database');
const app = require('../server');

let server, base, n = 0;

async function lookup(body) {
    const res = await fetch(base + '/api/tickets/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
}

// สร้างการจองตรงใน DB (กำหนดชื่อ/เบอร์ที่เก็บได้ตรงๆ เหมือนข้อมูลจริง) แล้วให้ทุกเคสใช้เบอร์ไม่ซ้ำกัน กันชนกับตัวนับการเดาผิด
async function seed(first, last, storedPhone, status = 'approved') {
    n++;
    const digits = '08' + String(10000000 + n).padStart(8, '0');
    await dbRun(
        `INSERT INTO bookings (booking_code, first_name, last_name, phone, slip_filename, status, ticket_token, total_amount)
         VALUES (?, ?, ?, ?, 'x', ?, ?, 1200)`,
        [`BK-TEST-${n}`, first, last, storedPhone ? storedPhone(digits) : digits, status, String(n).padStart(32, 'a')]
    );
    return digits;
}

before(async () => {
    await initDatabase();
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const CASES = [
    ['กรณีปกติ', 'สมชาย', 'ใจดี', 'สมชาย', 'ใจดี'],
    ['ช่องว่างเกินท้ายและกลางชื่อ', 'สมชาย', 'ใจ ดี', '  สมชาย ', 'ใจดี'],
    ['สระอำ: ที่เก็บเป็น ำ (U+0E33) แต่ลูกค้าพิมพ์เป็น นิกหิต+สระอา', 'กำพล', 'สำเนา', 'ก\u0E4D\u0E32พล', 'ส\u0E4D\u0E32เนา'],
    ['สระอำ: ที่เก็บเป็นนิกหิต+สระอา แต่ลูกค้าพิมพ์เป็น ำ', 'ก\u0E4D\u0E32พล', 'สำเนา', 'กำพล', 'สำเนา'],
    ['ช่องว่างแบบ non-breaking ในข้อมูลที่เก็บ', 'สม\u00A0ชาย', 'ใจดี', 'สมชาย', 'ใจดี'],
    ['อักขระล่องหน (zero-width) ในข้อมูลที่เก็บ', 'สม\u200Bชาย', 'ใจ\u200Bดี', 'สมชาย', 'ใจดี'],
    ['คำนำหน้าที่เก็บไว้ แต่ลูกค้าไม่พิมพ์', 'นายสมศักดิ์', 'รักไทย', 'สมศักดิ์', 'รักไทย'],
    ['ลูกค้าพิมพ์คำนำหน้า แต่ที่เก็บไม่มี', 'สมศักดิ์', 'รักไทย', 'นายสมศักดิ์', 'รักไทย'],
    ['ใส่ชื่อเต็มไว้ช่องชื่อ ตอนจอง', 'สมหญิง ใจงาม', '-', 'สมหญิง', 'ใจงาม'],
    ['กรอกสลับช่องชื่อ/นามสกุล', 'สมหญิง', 'ใจงาม', 'ใจงาม', 'สมหญิง'],
    ['ชื่ออังกฤษ ตัวพิมพ์ใหญ่เล็ก และเครื่องหมาย', 'John', "O'Brien", 'JOHN', 'obrien'],
    ['เ+เ พิมพ์แทน แ', 'เเดง', 'ขาว', 'แดง', 'ขาว'],
    ['วรรณยุกต์พิมพ์ก่อนสระ: ที่เก็บ สระ+วรรณยุกต์ แต่ลูกค้าพิมพ์ วรรณยุกต์+สระ (หนึ่ง)', 'หนึ่ง', 'สองสาม', 'ห\u0E19\u0E48\u0E36\u0E07', 'สองสาม'],
    ['วรรณยุกต์พิมพ์ก่อนสระ: กลับกัน (ที่เก็บเป็น วรรณยุกต์+สระ)', 'ห\u0E19\u0E48\u0E36\u0E07', 'สองสาม', 'หนึ่ง', 'สองสาม'],
    ['น้ำ กับ นำ้ (ลำดับวรรณยุกต์/สระอำสลับกัน)', 'น้ำฝน', 'ใจดี', 'นำ้ฝน', 'ใจดี'],
    ['พิมพ์วรรณยุกต์ซ้ำสองครั้ง', 'หนึ่ง', 'ใจดี', 'หนึ่\u0E48ง', 'ใจดี'],
];

for (const [label, sf, sl, inF, inL] of CASES) {
    test(`พบบัตร: ${label}`, async () => {
        const phone = await seed(sf, sl);
        const r = await lookup({ firstName: inF, lastName: inL, phone });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.bookings.length, 1);
    });
}

test('พบบัตร: เบอร์ที่เก็บเป็นรูปแบบเก่า (มีขีด/เว้นวรรค/+66) ลูกค้าพิมพ์รูปแบบไหนก็ได้', async () => {
    const dashed = await seed('สมชาย', 'ใจดี', d => `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`);
    assert.equal((await lookup({ firstName: 'สมชาย', lastName: 'ใจดี', phone: dashed })).status, 200);
    assert.equal((await lookup({ firstName: 'สมชาย', lastName: 'ใจดี', phone: '+66 ' + dashed.slice(1) })).status, 200);
    const spaced = await seed('สมชาย', 'ใจดี', d => `+66 ${d.slice(1, 3)} ${d.slice(3, 6)} ${d.slice(6)}`);
    assert.equal((await lookup({ firstName: 'สมชาย', lastName: 'ใจดี', phone: spaced })).status, 200);
});

test('พบทั้งรายการที่รอตรวจ/ปฏิเสธ (แต่ได้รหัสบัตรเฉพาะที่อนุมัติแล้ว)', async () => {
    const p = await seed('มานี', 'มีตา', null, 'pending');
    const r = await lookup({ firstName: 'มานี', lastName: 'มีตา', phone: p });
    assert.equal(r.status, 200);
    assert.equal(r.data.bookings[0].status, 'pending');
    assert.equal(r.data.bookings[0].ticketToken, null);
});

test('ไม่พบ: ชื่อต่างกันจริง (เบอร์ตรง)', async () => {
    const p = await seed('สมชาย', 'ใจดี');
    assert.equal((await lookup({ firstName: 'สมศรี', lastName: 'ใจดี', phone: p })).status, 404);
    assert.equal((await lookup({ firstName: 'สมชาย', lastName: 'ใจร้าย', phone: p })).status, 404);
});

test('ไม่พบ: ชื่อตรงแต่เบอร์ไม่ตรง และข้อความผิดพลาดเหมือนกัน (ไม่บอกว่าเบอร์มีในระบบ)', async () => {
    const p = await seed('สมชาย', 'ใจดี');
    const wrongName = await lookup({ firstName: 'ไม่ใช่', lastName: 'คนนี้', phone: p });
    const wrongPhone = await lookup({ firstName: 'สมชาย', lastName: 'ใจดี', phone: '0899999999' });
    assert.equal(wrongName.status, 404); assert.equal(wrongPhone.status, 404);
    assert.equal(wrongName.data.error, wrongPhone.data.error);
});

test('ไม่ปล่อยผ่านเมื่อกรอกชื่อว่าง/มีแต่เครื่องหมาย', async () => {
    const p = await seed('สมชาย', 'ใจดี');
    assert.equal((await lookup({ firstName: '.', lastName: '-', phone: p })).status, 404);
    assert.equal((await lookup({ firstName: ' ', lastName: ' ', phone: p })).status, 400);
});
