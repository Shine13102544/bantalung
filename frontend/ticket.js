// ==========================================================
// ticket.js — หน้า "ดูบัตรของฉัน" สำหรับลูกค้า
// กรอกชื่อ + นามสกุล + เบอร์โทร (หรือเปิดจากลิงก์ ?t=<token> ที่แอดมินส่งให้) เพื่อดูสถานะและ QR เข้างาน
// QR เก็บแค่รหัสลับของบัตร (BT1:<token>) ไม่มีข้อมูลส่วนตัว
// ==========================================================
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:3000' : '';
const $ = (id) => document.getElementById(id);

let lastQuery = null;           // { type: 'lookup', body } | { type: 'token', token } ใช้รีเฟรชสถานะอัตโนมัติ
let lastStatusMap = {};
let pollTimer = null;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function parseDbTime(s) {
    if (!s) return null;
    const d = new Date(String(s).replace(' ', 'T') + 'Z');   // เวลาใน DB เป็น UTC (Safari ไม่อ่านรูปแบบมีช่องว่าง)
    return Number.isNaN(d.getTime()) ? null : d;
}
function fmtTime(s) {
    const d = parseDbTime(s);
    return d ? d.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '-';
}
function money(n) { return (Number(n) || 0).toLocaleString('th-TH'); }

function showError(msg) {
    const e = $('err');
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
}

function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 4000);
}

// วาด QR ลง canvas (เว้นขอบขาว 4 โมดูลตามมาตรฐานให้สแกนง่าย)
function drawQr(canvas, text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), quiet = 4, cell = 8;
    const size = (n + quiet * 2) * cell;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
}

function renderTickets(list) {
    const box = $('results');
    box.textContent = '';
    list.forEach(t => {
        const card = el('div', 'card');
        const head = el('div', 'tk-head');
        head.appendChild(el('div', 'tk-name', t.name));
        const used = t.status === 'approved' && t.checkedIn;
        const chip = el('span', `chip ${used ? 'used' : t.status}`,
            used ? 'ใช้แล้ว' : t.status === 'approved' ? 'อนุมัติแล้ว' : t.status === 'pending' ? 'รอตรวจสอบสลิป' : 'ไม่ผ่าน/ยกเลิก');
        head.appendChild(chip);
        card.appendChild(head);

        const meta = el('div', 'tk-meta');
        const l1 = el('div'); l1.appendChild(document.createTextNode('🪑 โต๊ะ ')); l1.appendChild(el('span', 'tk-tables', (t.tables || []).join(', '))); meta.appendChild(l1);
        meta.appendChild(el('div', '', `🎫 รหัสจอง ${t.bookingCode}`));
        meta.appendChild(el('div', '', `💰 ${money(t.totalAmount)} บาท`));
        card.appendChild(meta);

        if (t.status === 'approved' && !t.checkedIn && t.ticketToken) {
            const qbox = el('div', 'qr-box');
            const canvas = document.createElement('canvas');
            qbox.appendChild(canvas);
            card.appendChild(qbox);
            drawQr(canvas, 'BT1:' + t.ticketToken);
            card.appendChild(el('div', 'qr-note', 'แสดง QR นี้ให้พนักงานสแกนที่ประตูทางเข้า\n(เพิ่มความสว่างหน้าจอให้สุดจะสแกนง่ายขึ้น)'));
            card.lastChild.style.whiteSpace = 'pre-line';
            const save = el('button', 'btn ghost', '⬇️ บันทึกรูป QR ไว้ในเครื่อง');
            save.type = 'button';
            save.addEventListener('click', () => {
                const a = document.createElement('a');
                a.href = canvas.toDataURL('image/png');
                a.download = `ticket-${t.bookingCode}.png`;
                document.body.appendChild(a); a.click(); a.remove();
            });
            card.appendChild(save);
        } else if (used) {
            const ub = el('div', 'used-box');
            ub.appendChild(el('b', '', '✅ เช็กอินเข้างานแล้ว'));
            ub.appendChild(document.createTextNode(`เมื่อเวลา ${fmtTime(t.checkedInAt)} น.`));
            card.appendChild(ub);
        } else if (t.status === 'pending') {
            card.appendChild(el('div', 'hint', '⏳ ทางร้านกำลังตรวจสอบสลิปของคุณ เมื่ออนุมัติแล้ว QR จะแสดงที่นี่อัตโนมัติ (หน้านี้รีเฟรชให้เองทุก 1 นาที)'));
        } else if (t.status === 'rejected') {
            card.appendChild(el('div', 'hint', '❌ การจองนี้ไม่ผ่านการตรวจสอบหรือถูกยกเลิก กรุณาติดต่อทางร้าน'));
        }
        box.appendChild(card);
    });
}

async function requestTickets(q) {
    const res = q.type === 'token'
        ? await fetch(`${API_BASE}/api/tickets/${encodeURIComponent(q.token)}`)
        : await fetch(`${API_BASE}/api/tickets/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q.body) });
    let data = {};
    try { data = await res.json(); } catch (_) { /* ไม่ใช่ JSON */ }
    return { ok: res.ok, status: res.status, data };
}

function schedulePoll(list) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!list.some(t => t.status === 'pending')) return;       // รีเฟรชอัตโนมัติเฉพาะตอนมีรายการรออนุมัติ
    pollTimer = setTimeout(async () => {
        if (!document.hidden && lastQuery) {
            const r = await requestTickets(lastQuery);
            if (r.ok) {
                const newly = r.data.bookings.find(t => t.status === 'approved' && lastStatusMap[t.bookingCode] === 'pending');
                applyResult(r.data.bookings);
                if (newly) toast('✅ การจองของคุณได้รับการอนุมัติแล้ว');
                return;
            }
        }
        schedulePoll(list);
    }, 60000);
}

function applyResult(list) {
    lastStatusMap = Object.fromEntries(list.map(t => [t.bookingCode, t.status]));
    renderTickets(list);
    schedulePoll(list);
}

$('lookup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const btn = $('submit-btn');
    btn.disabled = true; btn.textContent = 'กำลังค้นหา...';
    try {
        const body = { firstName: $('first-name').value.trim(), lastName: $('last-name').value.trim(), phone: $('phone').value.trim() };
        lastQuery = { type: 'lookup', body };
        const r = await requestTickets(lastQuery);
        if (!r.ok) {
            $('results').textContent = '';
            showError(r.data.error || 'ค้นหาไม่สำเร็จ กรุณาลองใหม่');
            return;
        }
        applyResult(r.data.bookings);
    } catch (err) {
        showError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
    } finally {
        btn.disabled = false; btn.textContent = 'ค้นหาบัตรของฉัน';
    }
});

(async function init() {
    try {
        const res = await fetch(`${API_BASE}/api/settings`);
        if (res.ok) {
            const s = await res.json();
            $('event-line').textContent = [s.concert_title, s.concert_date].filter(Boolean).join(' · ');
        }
    } catch (_) { /* ไม่มีข้อมูลงานก็ใช้หน้านี้ได้ */ }

    // เปิดจากลิงก์ที่แอดมินส่งให้ (?t=<token>) ไม่ต้องกรอกข้อมูล
    const token = new URLSearchParams(location.search).get('t');
    if (token) {
        $('lookup-form').style.display = 'none';
        lastQuery = { type: 'token', token };
        try {
            const r = await requestTickets(lastQuery);
            if (r.ok) applyResult(r.data.bookings);
            else { $('lookup-form').style.display = ''; showError(r.data.error || 'ไม่พบบัตร กรุณากรอกข้อมูลเพื่อค้นหา'); }
        } catch (_) {
            $('lookup-form').style.display = '';
            showError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่');
        }
    }
})();
