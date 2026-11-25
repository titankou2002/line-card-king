"""
line名片王 — YouTube 自動轉 10 秒 MP4 (≤10MB) + 封面圖微服務
部署目標：Google Cloud Run (含 yt-dlp + ffmpeg + boto3 直傳 Cloudflare R2)
POST /convert  { "url": "https://youtu.be/...", "start": 0, "slug": "bigt" }
回傳：{ "ok": true, "videoUrl": "https://cc.bigt.cc/...", "posterUrl": "https://cc.bigt.cc/...", "size": 2450112 }
"""
import os
import re
import time
import shutil
import tempfile
import subprocess
from flask import Flask, request, jsonify
from flask_cors import CORS
import boto3

app = Flask(__name__)
CORS(app)

MAX_BYTES = 10 * 1024 * 1024  # 10MB
R2_ENDPOINT = os.environ.get("R2_ENDPOINT", "")
R2_ACCESS_KEY = os.environ.get("R2_ACCESS_KEY", "")
R2_SECRET_KEY = os.environ.get("R2_SECRET_KEY", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_PUBLIC_URL = os.environ.get("R2_PUBLIC_URL", "https://cc.bigt.cc").rstrip("/")


def get_r2():
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        region_name="auto",
    )


def extract_yt_id(url: str) -> str:
    m = re.search(r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})", url or "")
    return m.group(1) if m else ""


@app.route("/health")
def health():
    return jsonify({"ok": True})


@app.route("/convert", methods=["POST"])
def convert_youtube():
    data = request.get_json(silent=True) or {}
    yt_url = str(data.get("url") or "").strip()
    slug = re.sub(r"[^a-z0-9_-]", "", str(data.get("slug") or "card").lower())[:24] or "card"
    start_sec = max(0, int(data.get("start") or 0))
    yt_id = extract_yt_id(yt_url)
    if not yt_id:
        return jsonify({"ok": False, "error": "無效的 YouTube 網址"}), 400

    workdir = tempfile.mkdtemp(prefix="yt10s_")
    try:
        raw_path = os.path.join(workdir, "raw.mp4")
        out_mp4 = os.path.join(workdir, "out.mp4")
        out_jpg = os.path.join(workdir, "poster.jpg")

        # 1. 只下載前 10 秒區段（720p 以內，省時省流量）
        section = f"*{start_sec}-{start_sec + 10}"
        cmd_dl = [
            "yt-dlp",
            "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[ext=mp4]",
            "--download-sections", section,
            "--force-keyframes-at-cuts",
            "-o", raw_path,
            f"https://www.youtube.com/watch?v={yt_id}",
        ]
        dl = subprocess.run(cmd_dl, capture_output=True, text=True, timeout=60)
        if dl.returncode != 0 or not os.path.exists(raw_path):
            return jsonify({"ok": False, "error": "YouTube 下載失敗"}), 502

        # 2. 轉檔為標準 H.264 靜音 MP4（≤10 秒、720p、faststart 秒開、壓至 ≤10MB）
        cmd_ff = [
            "ffmpeg", "-y", "-i", raw_path,
            "-t", "10",
            "-vf", "scale='min(1280,iw)':-2",
            "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
            "-crf", "26", "-maxrate", "2500k", "-bufsize", "5000k",
            "-an", "-movflags", "+faststart",
            out_mp4,
        ]
        subprocess.run(cmd_ff, check=True, capture_output=True, timeout=60)

        size = os.path.getsize(out_mp4)
        if size > MAX_BYTES:
            return jsonify({"ok": False, "error": "轉檔後超過 10MB"}), 413

        # 3. 擷取第 1 秒當封面圖
        subprocess.run(
            ["ffmpeg", "-y", "-i", out_mp4, "-ss", "00:00:01", "-vframes", "1", "-q:v", "3", out_jpg],
            capture_output=True, timeout=20,
        )

        ts = int(time.time() * 1000)
        mp4_key = f"ecard_{slug}_yt_{ts}.mp4"
        jpg_key = f"ecard_{slug}_yt_{ts}.jpg"

        s3 = get_r2()
        with open(out_mp4, "rb") as f:
            s3.put_object(Bucket=R2_BUCKET, Key=mp4_key, Body=f, ContentType="video/mp4")

        poster_url = f"https://i.ytimg.com/vi/{yt_id}/hqdefault.jpg"
        if os.path.exists(out_jpg):
            with open(out_jpg, "rb") as f:
                s3.put_object(Bucket=R2_BUCKET, Key=jpg_key, Body=f, ContentType="image/jpeg")
            poster_url = f"{R2_PUBLIC_URL}/{jpg_key}"

        return jsonify({
            "ok": True,
            "videoUrl": f"{R2_PUBLIC_URL}/{mp4_key}",
            "posterUrl": poster_url,
            "key": mp4_key,
            "size": size,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
