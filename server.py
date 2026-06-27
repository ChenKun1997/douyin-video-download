#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音无水印下载 - 本地 Web 服务

启动后访问: http://127.0.0.1:8000
复用 douyin_download.py 的解析逻辑, 提供 Web 界面交互。

零依赖: 仅使用 Python 标准库。

用法:
    python3 server.py              # 启动并自动打开浏览器
    python3 server.py --port 9000  # 指定端口
    python3 server.py --no-open    # 不自动打开浏览器
"""

import argparse
import json
import os
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 复用已有的解析模块
import douyin_download as dd

HOST = "127.0.0.1"
DEFAULT_PORT = 8000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------------
# CDN 地址缓存 (视频预览会发多次 Range 请求, 缓存最终地址避免重复解析)
# ----------------------------------------------------------------------

class _TTLCache:
    """带过期时间的简易缓存。"""
    def __init__(self, ttl=300):
        self.ttl = ttl
        self._store = {}  # key -> (value, expire_ts)

    def get(self, key):
        item = self._store.get(key)
        if item and item[1] > time.time():
            return item[0]
        return None

    def set(self, key, value):
        self._store[key] = (value, time.time() + self.ttl)


_CDN_CACHE = _TTLCache(ttl=300)  # 5 分钟


# ----------------------------------------------------------------------
# 业务逻辑
# ----------------------------------------------------------------------

def find_cover(data):
    """在解析出的 JSON 中查找封面图 URL。"""
    found = {"v": None}

    def walk(obj):
        if found["v"]:
            return
        if isinstance(obj, dict):
            for key, val in obj.items():
                if "cover" in key.lower() and isinstance(val, dict):
                    urls = val.get("url_list")
                    if isinstance(urls, list) and urls and isinstance(urls[0], str):
                        found["v"] = urls[0]
                        return
                walk(val)
        elif isinstance(obj, list):
            for v in obj:
                walk(v)

    walk(data)
    return found["v"]


def parse_douyin(text, use_doh=True):
    """解析抖音链接, 返回视频信息字典。"""
    url = dd.extract_url(text)
    aweme_id = dd.get_aweme_id(url, use_doh=use_doh)
    html = dd.fetch_share_page(aweme_id, use_doh=use_doh)
    data = dd.extract_router_data(html)
    if not data:
        raise ValueError("无法解析页面数据, 抖音接口可能已变更")

    qualities = dd.get_all_qualities(data)
    if not qualities:
        raise ValueError("未能从页面找到视频地址")

    meta = dd._extract_meta(data)
    cover_url = find_cover(data)
    # 默认选 720p 作为主地址 (兼容旧前端字段 video_url)
    default_url = next((q["url"] for q in qualities if q["ratio"] == "720p"), qualities[0]["url"])
    return {
        "aweme_id": aweme_id,
        "title": meta.get("title") or aweme_id,
        "author": meta.get("author", ""),
        "video_url": default_url,   # 默认清晰度地址 (兼容)
        "qualities": qualities,     # 全部清晰度列表
        "cover_url": cover_url,
        "source_url": url,
    }


# ----------------------------------------------------------------------
# HTTP 服务
# ----------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    # 用 HTTP/1.1 以支持流式代理下载 (需正确设置 Content-Length)
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静默默认日志
        pass

    # ---- 工具方法 ----
    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, path):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self._send_json(404, {"ok": False, "error": "index.html 不存在"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        return self.rfile.read(length) if length else b""

    # ---- 路由 ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            self._send_html(os.path.join(BASE_DIR, "index.html"))
        elif path == "/api/proxy":
            self._handle_proxy(parsed.query)
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/parse":
            self._handle_parse()
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    # ---- 接口实现 ----
    def _handle_parse(self):
        try:
            payload = json.loads(self._read_body() or b"{}")
            text = (payload.get("text") or "").strip()
            if not text:
                self._send_json(400, {"ok": False, "error": "请输入抖音链接或分享文案"})
                return
            info = parse_douyin(text)
            self._send_json(200, {"ok": True, "data": info})
        except ValueError as e:
            self._send_json(400, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send_json(500, {"ok": False, "error": f"服务器错误: {e}"})

    def _handle_proxy(self, query):
        """流式代理下载: 用 DoH 直连抖音 CDN, 边读边转发给浏览器。

        解决两个问题:
        1. 抖音视频地址(aweme.snssdk.com)被本地 DNS 污染 -> DoH 解析真实IP
        2. 浏览器跨域无法直接下载 -> 由后端代理转发
        """
        params = urllib.parse.parse_qs(query)
        url = params.get("url", [None])[0]
        filename = params.get("filename", ["video.mp4"])[0]
        mode = params.get("mode", ["download"])[0]  # download | inline
        if not url:
            self._send_json(400, {"ok": False, "error": "缺少 url 参数"})
            return
        try:
            import http.client as hc
            from urllib.parse import urljoin

            # 1. 跟随重定向拿到最终 CDN 地址 (带缓存, 避免每次 Range 请求都重新解析)
            final_url = _CDN_CACHE.get(url)
            if not final_url:
                final_url, status, _, _ = dd.http_get(
                    url,
                    headers={"User-Agent": dd.MOBILE_UA, "Referer": dd.HOMEPAGE_URL,
                             "Range": "bytes=0-"},
                    allow_redirects=True,
                )
                _CDN_CACHE.set(url, final_url)
            parsed = urllib.parse.urlparse(final_url)
            host = parsed.hostname
            port = parsed.port or 443
            ips = dd.doh_resolve(host)
            if not ips:
                ips = [host]
            req_path = parsed.path or "/"
            if parsed.query:
                req_path += "?" + parsed.query

            # 浏览器可能带 Range 请求 (视频拖动进度条), 透传给 CDN
            client_range = self.headers.get("Range")

            # 2. 建立连接, 流式转发
            conn = None
            last_err = None
            for ip in ips:
                try:
                    conn = dd._connect_https(ip, port, host, 30)
                    req_headers = {
                        "Host": host, "User-Agent": dd.MOBILE_UA,
                        "Referer": dd.HOMEPAGE_URL,
                    }
                    # 透传客户端的 Range (预览拖动); 下载则从0开始
                    if client_range:
                        req_headers["Range"] = client_range
                    else:
                        req_headers["Range"] = "bytes=0-"
                    conn.request("GET", req_path, headers=req_headers)
                    resp = conn.getresponse()
                    if resp.status not in (200, 206):
                        last_err = f"CDN HTTP {resp.status}"
                        conn.close()
                        conn = None
                        continue
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
                    conn = None
                    continue
            if conn is None:
                self._send_json(502, {"ok": False, "error": f"下载失败: {last_err}"})
                return

            content_type = resp.getheader("Content-Type") or "video/mp4"
            total = resp.getheader("Content-Length")
            content_range = resp.getheader("Content-Range")

            # 预览(inline): 保留 CDN 的 206 状态码和 Content-Range, 让浏览器
            #   能拖动进度条; 下载: 用 200 + attachment
            if mode == "inline" and resp.status == 206:
                self.send_response(206)
            else:
                self.send_response(200)
            self.send_header("Content-Type", content_type)
            # 透传 Accept-Ranges / Content-Range (视频拖动必需)
            accept_ranges = resp.getheader("Accept-Ranges") or "bytes"
            self.send_header("Accept-Ranges", accept_ranges)
            if content_range:
                self.send_header("Content-Range", content_range)
            # Content-Disposition: 预览用 inline, 下载用 attachment
            quoted = urllib.parse.quote(filename)
            disposition = "inline" if mode == "inline" else "attachment"
            self.send_header(
                "Content-Disposition",
                f'{disposition}; filename="video.mp4"; filename*=UTF-8\'\'{quoted}',
            )
            if total:
                self.send_header("Content-Length", total)
            self.send_header("Connection", "close")
            self.end_headers()

            # 流式转发, 避免大文件占内存
            while True:
                buf = resp.read(64 * 1024)
                if not buf:
                    break
                self.wfile.write(buf)
        except Exception as e:  # noqa: BLE001
            try:
                self._send_json(502, {"ok": False, "error": f"下载失败: {e}"})
            except Exception:
                pass  # headers 可能已发送, 忽略


# ----------------------------------------------------------------------
# 启动
# ----------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="抖音无水印下载 - 本地 Web 服务")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="端口号")
    parser.add_argument("--host", default=HOST, help="监听地址")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"

    print("=" * 52)
    print("  抖音无水印下载 - 本地服务已启动")
    print(f"  地址: {url}")
    print("  按 Ctrl+C 停止")
    print("=" * 52)

    if not args.no_open:
        # 延迟打开, 等服务真正起来
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        server.shutdown()


if __name__ == "__main__":
    main()
