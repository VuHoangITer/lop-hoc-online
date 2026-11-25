# Lớp học online

Bảng trắng realtime: giáo viên viết/vẽ/gõ công thức, học sinh vào bằng link để xem trực tiếp.
Nhiều trang, lưu cả trang bài tập về máy thành ảnh (💾).

## Chạy thử trên máy
    npm install
    node server.js

## Dùng (1 lớp, 1 link, mọi người cùng quyền)
Chỉ có 1 bảng, lưu mãi. Ai mở link (ví dụ https://ten-mien-cua-ban/) cũng vẽ, xóa, thêm trang được như nhau.

- Lần đầu mở: nhập tên. Lần sau vào thẳng bảng.
- ⭐: bảng điểm cộng/trừ kèm lý do và lịch sử. Lưu trong data/rooms.json; mỗi trình duyệt giữ 1 bản sao, nếu server mất file (Render khởi động lại) thì máy vào đầu tiên tự gửi lại điểm.
- Chỉ máy nhập đúng mã PIN (biến môi trường `SCORE_PIN`, mặc định `1234`) mới cộng/trừ điểm và chích điện ⚡ được; máy khác chỉ xem.
- 💾: lưu cả trang (mọi nét, chữ, công thức, ảnh) thành 1 ảnh PNG về máy.
- Đổi tên lớp: biến môi trường `CLASS_TITLE="Toán 9 - Bin"`.
- Không có mật khẩu: đừng đăng link công khai, ai có link đều sửa được bảng.

## Triển khai lên server (VPS)
    npm install --omit=dev
    npm i -g pm2
    PORT=3000 pm2 start server.js --name lophoc
    pm2 save

Nginx — thêm vào location:
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
Sau đó chạy certbot để có https. Dữ liệu lớp lưu ở data/rooms.json (đổi thư mục bằng biến DATA_DIR).

Có thể deploy lên Render / Railway / Fly.io: Build `npm install`, Start `node server.js`,
nhớ gắn disk/volume vào thư mục data nếu muốn giữ bài sau khi server khởi động lại.

## Ghi chú
  vì chưa có TURN server; khi đó dùng Google Meet/Zoom song song, bảng vẫn dùng bình thường.
- Công thức dùng KaTeX (CDN jsdelivr). Hóa học dùng $\ce{...}$.
