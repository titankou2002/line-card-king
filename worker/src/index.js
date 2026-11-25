/**
 * line名片王 — Cloudflare Worker API
 * 綁定獨立 R2 Bucket: line-card-king
 * 功能：
 *  - POST   /api/upload?kind=logo|photo|video  (驗證登入、影片限 10MB 與額度、傳新 Logo/照片自動刪舊檔)
 *  - DELETE /api/asset?kind=logo|photo|video   (實體刪除 R2 檔案並釋放影片額度)
 *  - GET    /f/<key>                           (公開檔案讀取，支援影片 Range 串流)
 *  - GET    /api/admin/list                    (管理員取得全部註冊會員與檔案用量)
 *  - POST   /api/admin/update                  (管理員調整狀態或影片額度)
 *  - POST   /api/admin/delete                  (管理員刪除帳號並清空其 R2 檔案)
 */

const MAX_VIDEO_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024; // 2.5MB

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }
  });
}

async function sbFetch(env, path, opts = {}) {
  const url = env.SUPABASE_URL.replace(/\/$/, "") + path;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
    "Content-Type": "application/json",
    ...(opts.headers || {})
  };
  return fetch(url, { ...opts, headers });
}

/* 驗證前端送來的 Supabase Access Token，取得 user.id 與 card_profiles 列 */
async function verifyUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;

  const uRes = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + token }
  });
  if (!uRes.ok) return null;
  const user = await uRes.json();
  if (!user || !user.id) return null;

  const pRes = await sbFetch(env, "/rest/v1/card_profiles?id=eq." + encodeURIComponent(user.id) + "&select=*");
  if (!pRes.ok) return null;
  const rows = await pRes.json();
  return { user, profile: rows[0] || null };
}

async function isAdminReq(request, env) {
  const key = request.headers.get("X-Admin-Key") || "";
  if (env.ADMIN_KEY && key && key === env.ADMIN_KEY) return true;
  const auth = await verifyUser(request, env);
  return !!(auth && auth.profile && auth.profile.is_admin);
}

function publicFileUrl(request, env, key) {
  const custom = (env.R2_PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (custom) return custom + "/" + key;
  const origin = new URL(request.url).origin;
  return origin + "/f/" + key;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. 公開讀取 R2 檔案（支援影片 Range 串流，LINE 播放影片必備）
    if (request.method === "GET" && path.startsWith("/f/")) {
      const key = decodeURIComponent(path.slice(3));
      if (!key || key.includes("..")) return new Response("Not found", { status: 404 });

      const rangeHeader = request.headers.get("range");
      const obj = await env.CARD_BUCKET.get(key, rangeHeader ? { range: request.headers } : undefined);
      if (!obj) return new Response("Not found", { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Access-Control-Allow-Origin", "*");

      if (rangeHeader && obj.range) {
        const start = obj.range.offset || 0;
        const end = start + obj.range.length - 1;
        headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
        headers.set("Content-Length", String(obj.range.length));
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set("Content-Length", String(obj.size));
      return new Response(obj.body, { status: 200, headers });
    }

    // 2. 上傳檔案到獨立 R2 Bucket（logo / photo / video）
    if (request.method === "POST" && path === "/api/upload") {
      const auth = await verifyUser(request, env);
      if (!auth || !auth.profile) return json({ ok: false, error: "請先登入" }, 401);
      const prof = auth.profile;
      if (prof.status !== "active") return json({ ok: false, error: "帳號已停用" }, 403);

      const kind = url.searchParams.get("kind") || "logo";
      if (!["logo", "photo", "video"].includes(kind)) {
        return json({ ok: false, error: "無效的檔案類型" }, 400);
      }

      const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      const buf = await request.arrayBuffer();

      if (kind === "video") {
        if (prof.video_quota <= 0) return json({ ok: false, error: "無影片上傳額度" }, 403);
        if (prof.video_key) return json({ ok: false, error: "已達影片上限，請先刪除舊影片" }, 409);
        if (contentType !== "video/mp4") return json({ ok: false, error: "僅支援 MP4" }, 400);
        if (buf.byteLength > MAX_VIDEO_BYTES) return json({ ok: false, error: "影片超過 10MB" }, 413);
      } else {
        if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
          return json({ ok: false, error: "僅支援 PNG / JPG / WEBP" }, 400);
        }
        if (buf.byteLength > MAX_IMAGE_BYTES) return json({ ok: false, error: "圖片超過 2.5MB" }, 413);
      }

      const ext = contentType === "video/mp4" ? "mp4" : (contentType === "image/png" ? "png" : (contentType === "image/webp" ? "webp" : "jpg"));
      const key = `${prof.slug}_${kind}_${Date.now()}.${ext}`;

      // 上傳到全新獨立 Bucket: line-card-king
      await env.CARD_BUCKET.put(key, buf, { httpMetadata: { contentType } });
      const fileUrl = publicFileUrl(request, env, key);

      // 若是 logo / photo，自動刪除 R2 舊檔避免堆積垃圾
      const oldKey = kind === "logo" ? prof.logo_key : (kind === "photo" ? prof.photo_key : "");
      if (oldKey && oldKey !== key) {
        try { await env.CARD_BUCKET.delete(oldKey); } catch (e) {}
      }

      // 更新 Supabase 記錄
      const nextCfg = Object.assign({}, prof.config || {});
      const patch = {};
      if (kind === "video") {
        patch.video_key = key;
        patch.video_size_bytes = buf.byteLength;
        nextCfg.videoUrl = fileUrl;
      } else if (kind === "logo") {
        patch.logo_key = key;
        nextCfg.logoUrl = fileUrl;
      } else {
        patch.photo_key = key;
        nextCfg.photoUrl = fileUrl;
      }
      patch.config = nextCfg;

      await sbFetch(env, "/rest/v1/card_profiles?id=eq." + encodeURIComponent(prof.id), {
        method: "PATCH",
        body: JSON.stringify(patch)
      });

      return json({ ok: true, key, url: fileUrl, size: buf.byteLength });
    }

    // 3. 刪除自己的 R2 檔案（釋放影片額度）
    if (request.method === "DELETE" && path === "/api/asset") {
      const auth = await verifyUser(request, env);
      if (!auth || !auth.profile) return json({ ok: false, error: "請先登入" }, 401);
      const prof = auth.profile;
      const kind = url.searchParams.get("kind") || "";
      if (!["logo", "photo", "video"].includes(kind)) {
        return json({ ok: false, error: "無效類型" }, 400);
      }

      const oldKey = kind === "video" ? prof.video_key : (kind === "logo" ? prof.logo_key : prof.photo_key);
      if (oldKey) {
        try { await env.CARD_BUCKET.delete(oldKey); } catch (e) {}
      }

      const nextCfg = Object.assign({}, prof.config || {});
      const patch = {};
      if (kind === "video") {
        patch.video_key = "";
        patch.video_size_bytes = 0;
        nextCfg.videoUrl = "";
      } else if (kind === "logo") {
        patch.logo_key = "";
        nextCfg.logoUrl = "";
      } else {
        patch.photo_key = "";
        nextCfg.photoUrl = "";
      }
      patch.config = nextCfg;

      await sbFetch(env, "/rest/v1/card_profiles?id=eq." + encodeURIComponent(prof.id), {
        method: "PATCH",
        body: JSON.stringify(patch)
      });

      return json({ ok: true, deleted: oldKey || "" });
    }

    // 4. 管理員 API：列出所有註冊會員
    if (request.method === "GET" && path === "/api/admin/list") {
      if (!(await isAdminReq(request, env))) return json({ ok: false, error: "無權限" }, 403);
      const res = await sbFetch(env, "/rest/v1/card_profiles?select=*&order=created_at.desc");
      const items = await res.json();
      return json({ ok: true, items: Array.isArray(items) ? items : [] });
    }

    // 5. 管理員 API：更新狀態或影片額度
    if (request.method === "POST" && path === "/api/admin/update") {
      if (!(await isAdminReq(request, env))) return json({ ok: false, error: "無權限" }, 403);
      const body = await request.json();
      if (!body || !body.id) return json({ ok: false, error: "缺少 id" }, 400);
      const patch = {};
      if (body.status === "active" || body.status === "suspended") patch.status = body.status;
      if (typeof body.video_quota === "number" && body.video_quota >= 0) patch.video_quota = Math.floor(body.video_quota);
      await sbFetch(env, "/rest/v1/card_profiles?id=eq." + encodeURIComponent(body.id), {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      return json({ ok: true });
    }

    // 6. 管理員 API：刪除會員並清空該會員所有 R2 檔案
    if (request.method === "POST" && path === "/api/admin/delete") {
      if (!(await isAdminReq(request, env))) return json({ ok: false, error: "無權限" }, 403);
      const body = await request.json();
      if (!body || !body.id) return json({ ok: false, error: "缺少 id" }, 400);

      const pRes = await sbFetch(env, "/rest/v1/card_profiles?id=eq." + encodeURIComponent(body.id) + "&select=logo_key,photo_key,video_key");
      const rows = await pRes.json();
      const rec = rows[0];
      if (rec) {
        for (const k of [rec.logo_key, rec.photo_key, rec.video_key]) {
          if (k) { try { await env.CARD_BUCKET.delete(k); } catch (e) {} }
        }
      }
      await sbFetch(env, "/rest/v1/card_profiles?id=eq." + encodeURIComponent(body.id), { method: "DELETE" });
      await sbFetch(env, "/auth/v1/admin/users/" + encodeURIComponent(body.id), { method: "DELETE" });
      return json({ ok: true });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};
