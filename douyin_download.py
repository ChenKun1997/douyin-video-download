#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音无水印视频下载工具 (Douyin Watermark-Free Video Downloader)

原理:
    1. 从用户分享文本中提取短链 (https://v.douyin.com/xxxxx/)
    2. 解析短链重定向, 拿到视频唯一 ID (aweme_id)
    3. 请求 iesdouyin 移动端分享页, 从内嵌 _ROUTER_DATA JSON 中
       提取 play_addr (playwm 带水印), 替换为 play 即无水印地址
    4. 下载视频

★ 关键: 通过公共 DoH (DNS over HTTPS) 解析真实 IP, 再用自定义 Host
  头 + SSL SNI 直连, 绕过本地 DNS 污染 (v.douyin.com / iesdouyin.com /
  aweme.snssdk.com 在部分网络下会被解析到无效 IP)。

零依赖: 仅使用 Python 标准库, 开箱即用。

用法:
    python3 douyin_download.py "分享文本或链接"
    python3 douyin_download.py "链接" -o ./videos
    python3 douyin_download.py "链接" --info   # 仅查看信息不下载
    python3 douyin_download.py "链接" --no-doh # 关闭 DoH (本地DNS正常时)
"""

import argparse
import http.client
import json
import os
import re
import socket
import ssl
import sys
import time
from urllib.parse import urljoin, urlparse, quote

# ----------------------------------------------------------------------
# 常量 / 请求头
# ----------------------------------------------------------------------

MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/16.6 Mobile/15E148 Safari/604.1"
)
DESKTOP_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)

HOMEPAGE_URL = "https://www.iesdouyin.com/"
# DoH 服务 (阿里 + 腾讯, 互为备份)
DOH_SERVERS = [
    ("https://dns.alidns.com/resolve", "dns.alidns.com"),
    ("https://doh.pub/dns-query", "doh.pub"),
]
DOH_TIMEOUT = 6

INVALID_CHARS = re.compile(r'[\\/:*?"<>|\n\r\t]')

# IP 缓存: domain -> [ip, ...]  (进程内, 避免重复 DoH 查询)
_IP_CACHE = {}


# ----------------------------------------------------------------------
# DoH 解析 (绕过本地 DNS 污染)
# ----------------------------------------------------------------------

def doh_resolve(domain):
    """用公共 DoH 查询域名真实 A 记录, 返回 IPv4 列表。"""
    if domain in _IP_CACHE:
        return _IP_CACHE[domain]

    ips = []
    for doh_url, doh_host in DOH_SERVERS:
        try:
            ips = _doh_query(doh_url, doh_host, domain)
            if ips:
                break
        except Exception:
            continue

    if not ips:
        # DoH 全失败, 退回系统 DNS (可能被污染, 但聊胜于无)
        try:
            infos = socket.getaddrinfo(domain, None, socket.AF_INET)
            ips = list({i[4][0] for i in infos}) or []
        except Exception:
            ips = []

    _IP_CACHE[domain] = ips
    return ips


def _doh_query(doh_url, doh_host, domain):
    """单次 DoH JSON 查询。"""
    url = f"{doh_url}?name={domain}&type=A"
    ctx = ssl.create_default_context()
    # DoH 服务器通常用系统 DNS 即可达 (它们是公共递归解析器)
    conn = http.client.HTTPSConnection(doh_host, timeout=DOH_TIMEOUT, context=ctx)
    try:
        conn.request("GET", url.split(doh_host, 1)[1], headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/dns-json",
        })
        resp = conn.getresponse()
        if resp.status != 200:
            return []
        data = json.loads(resp.read().decode("utf-8"))
        ips = [
            a["data"] for a in data.get("Answer", [])
            if a.get("type") == 1 and re.match(r"^\d+\.\d+\.\d+\.\d+$", a.get("data", ""))
        ]
        return ips
    finally:
        conn.close()


# ----------------------------------------------------------------------
# 网络: 支持 DoH + 真实IP直连
# ----------------------------------------------------------------------

def _connect_https(ip, port, hostname, timeout):
    """连接到真实 IP, 但 SSL SNI / 证书校验使用真实域名。

    关键: http.client.HTTPSConnection 默认用连接目标(IP)做证书校验,
    会因 IP 不在证书 SAN 里而失败。这里手动 wrap_socket 并指定
    server_hostname=域名, 让 SNI 和校验都走域名。
    """
    ctx = ssl.create_default_context()
    raw = socket.create_connection((ip, port), timeout=timeout)
    sock = ctx.wrap_socket(raw, server_hostname=hostname)
    conn = http.client.HTTPSConnection(hostname, port, timeout=timeout)
    # 替换底层 socket 和 SSL 上下文, 复用已建立的连接
    conn.sock = sock
    return conn


def http_get(url, headers=None, allow_redirects=True, max_redirects=8, timeout=20,
             use_doh=True):
    """HTTP(S) GET, 自动处理重定向。

    use_doh=True 时, 通过 DoH 解析真实 IP 直连, 绕过本地 DNS 污染。
    返回 (final_url, status, response_headers, body_bytes)。
    body_bytes 为 None 表示这是重定向中间跳 (调用方一般只用 final_url)。
    """
    headers = headers or {}
    if "User-Agent" not in headers:
        headers["User-Agent"] = MOBILE_UA

    current = url
    for _ in range(max_redirects):
        parsed = urlparse(current)
        scheme = parsed.scheme
        host = parsed.hostname
        port = parsed.port or (443 if scheme == "https" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        # 选 IP
        if use_doh and scheme == "https":
            ips = doh_resolve(host)
        else:
            ips = []
        if not ips:
            ips = [host]  # 退回用域名

        last_err = None
        body = None
        status = None
        resp_headers = {}
        for ip in ips:
            try:
                if scheme == "https":
                    conn = _connect_https(ip, port, host, timeout)
                else:
                    conn = http.client.HTTPConnection(ip, port, timeout=timeout)

                req_headers = dict(headers)
                req_headers["Host"] = host  # 用真实域名做 Host 头
                conn.request("GET", path, headers=req_headers)
                resp = conn.getresponse()
                status = resp.status
                resp_headers = {k.lower(): v for k, v in resp.getheaders()}
                location = resp_headers.get("location")

                if status in (301, 302, 303, 307, 308) and location and allow_redirects:
                    conn.close()
                    current = urljoin(current, location)
                    body = None
                    break  # 跳到下一轮重定向
                else:
                    body = resp.read()
                    conn.close()
                    return current, status, resp_headers, body
            except Exception as e:
                last_err = e
                continue  # 换下一个 IP

        if body is None and last_err and status is None:
            # 所有 IP 都连不上
            raise last_err
        # 否则是重定向, 继续 loop
    else:
        raise RuntimeError("重定向次数过多")

    return current, status, resp_headers, body


# ----------------------------------------------------------------------
# 解析逻辑
# ----------------------------------------------------------------------

def extract_url(text):
    """从分享文本中提取 http(s) 链接。"""
    if not text:
        raise ValueError("输入为空")
    match = re.search(r"https?://[^\s，。]+", text)
    if not match:
        raise ValueError(f"未在输入中找到链接: {text}")
    return match.group(0)


def get_aweme_id(url, use_doh=True):
    """从任意抖音链接解析出 aweme_id。"""
    # 链接里已直接含 ID
    direct = re.search(r"/video/(\d+)", url)
    if direct:
        return direct.group(1)

    # 短链: 跟随重定向, 从最终 URL 提取
    final_url, status, _, _ = http_get(url, use_doh=use_doh, allow_redirects=True)
    m = re.search(r"/video/(\d+)", final_url)
    if m:
        return m.group(1)
    # 兜底: 某些跳转目标带 ?previous_page=app_code_link 等, 仍可能在 query 里
    m = re.search(r"(\d{15,})", final_url)
    if m:
        return m.group(1)
    raise ValueError(f"无法从链接解析视频 ID: {url}")


def fetch_share_page(aweme_id, use_doh=True):
    """请求移动端分享页 HTML (真实 IP 直连)。"""
    url = f"https://www.iesdouyin.com/share/video/{aweme_id}/"
    headers = {
        "User-Agent": MOBILE_UA,
        "Referer": HOMEPAGE_URL,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    final_url, status, _, body = http_get(url, headers=headers, use_doh=use_doh)
    if status != 200 or not body:
        raise ValueError(f"分享页请求失败: HTTP {status}")
    return body.decode("utf-8", errors="replace")


def extract_router_data(html):
    """用括号深度匹配从 HTML 中精确提取 _ROUTER_DATA JSON。"""
    marker = "window._ROUTER_DATA = "
    idx = html.find(marker)
    if idx < 0:
        # 备选标记
        idx = html.find("_ROUTER_DATA")
        if idx < 0:
            return None
        eq = html.find("=", idx)
        if eq < 0:
            return None
        start = eq + 1
    else:
        start = idx + len(marker)

    while start < len(html) and html[start] in " \t\n":
        start += 1
    if start >= len(html) or html[start] != "{":
        return None

    # 括号深度匹配 (考虑字符串内的括号和转义)
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(html)):
        c = html[i]
        if escape:
            escape = False
            continue
        if c == "\\":
            escape = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                raw = html[start:i + 1]
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    return None
    return None


def _walk_find(obj, found):
    """递归在 JSON 里寻找视频信息。"""
    if isinstance(obj, dict):
        if "playApi" in obj and isinstance(obj["playApi"], str) and "playApi" not in found:
            found["playApi"] = obj["playApi"]
        # play_addr / download_addr 的 url_list
        if "url_list" in obj and isinstance(obj["url_list"], list) and obj["url_list"]:
            urls = [u for u in obj["url_list"] if isinstance(u, str) and u]
            if urls:
                # 带水印 playwm 优先存; 也会在 walk 中遇到 play(无水印)
                if any("play" in u for u in urls):
                    if "play_urls" not in found:
                        found["play_urls"] = []
                    found["play_urls"].extend(urls)
        # 收集 video_id (play_addr.uri 或 URL 里的 video_id 参数)
        if "uri" in obj and isinstance(obj["uri"], str) and not found.get("video_id"):
            uri = obj["uri"]
            # uri 形如 v0300fg10000d8dd3ivog65gljtkshi0
            if re.match(r"^v0[0-9a-f]+$", uri):
                found["video_id"] = uri
        # 记录原始分辨率: 仅在 video 节点 (同时含 play_addr/duration) 上记录
        # 避免误取封面图(cover)的尺寸
        if "play_addr" in obj and "width" in obj and "height" in obj \
                and isinstance(obj["width"], int) and isinstance(obj["height"], int):
            if not found.get("resolution"):
                found["resolution"] = (obj["width"], obj["height"])
        if "desc" in obj and isinstance(obj["desc"], str) and not found.get("title"):
            found["title"] = obj["desc"]
        if "nickname" in obj and isinstance(obj["nickname"], str) and not found.get("author"):
            found["author"] = obj["nickname"]
        for v in obj.values():
            _walk_find_video_meta(v, found)
    elif isinstance(obj, list):
        for v in obj:
            _walk_find_video_meta(v, found)


def _walk_find_video_meta(obj, found):
    """别名, 保持递归入口一致。"""
    _walk_find(obj, found)


# 清晰度档位定义 (ratio 值 -> 展示名)
# 抖音 play 接口的 ratio 参数控制清晰度, 实测均有效且码率严格递增。
# 注: "default"(原画) 走未转码原始文件通道, 抖音限制严格、常返回空/降级,
#     质量不保证, 故不提供。保留 1080p 作为最高稳定档。
QUALITY_RATIOS = [
    ("1080p", "1080P"),    # 全高清 (最高稳定档, ~2.7Mbps)
    ("720p", "720P"),      # 高清 (~2.1Mbps)
    ("540p", "540P"),      # 标清 (~1.8Mbps)
]


def build_play_url(video_id, ratio, base_url=None):
    """根据 video_id 和 ratio 构造无水印播放地址。

    无水印: 用 /play/ 而非 /playwm/。
    """
    if base_url:
        # 沿用原始地址的 host 和其他参数
        m = re.search(r"(https?://[^/]+/aweme/v1/play(?:wm)?/)", base_url)
        prefix = m.group(1).replace("playwm", "play") if m else \
                 "https://aweme.snssdk.com/aweme/v1/play/"
        # 保留原有的额外参数 (如 line)
        extra = ""
        em = re.search(r"&(line=\d+)", base_url)
        if em:
            extra = em.group(1)
        return f"{prefix}?video_id={video_id}&ratio={ratio}{extra}"
    return f"https://aweme.snssdk.com/aweme/v1/play/?video_id={video_id}&ratio={ratio}&line=0"


def resolve_no_watermark_url(data):
    """从 JSON 中确定无水印视频地址 (默认清晰度)。"""
    qualities = get_all_qualities(data)
    if qualities:
        # 默认取第一个非原画的 (720p 优先), 兼顾质量与体积
        for q in qualities:
            if q["ratio"] == "720p":
                return q["url"], q
        return qualities[0]["url"], qualities[0]
    return None, {}


def get_all_qualities(data):
    """从解析数据中提取所有清晰度选项。

    返回列表, 每项: {ratio, label, url}, 按"原画->标清"顺序。
    """
    found = {}
    _walk_find(data, found)

    video_id = found.get("video_id")
    # 兜底: 从 URL 里提取 video_id
    if not video_id:
        for u in (found.get("play_urls") or []):
            m = re.search(r"video_id=([0-9a-zA-Z]+)", u)
            if m:
                video_id = m.group(1)
                break
    if not video_id:
        return []

    # 找一个原始 URL 作为模板 (保留 line 等参数)
    template = None
    for u in (found.get("play_urls") or []):
        if "video_id=" in u:
            template = u
            break

    qualities = []
    for ratio, label in QUALITY_RATIOS:
        url = build_play_url(video_id, ratio, template)
        qualities.append({"ratio": ratio, "label": label, "url": url})
    return qualities


# ----------------------------------------------------------------------
# 下载
# ----------------------------------------------------------------------

def sanitize_filename(name, max_len=80):
    name = INVALID_CHARS.sub(" ", name).strip()
    name = re.sub(r"\s+", " ", name)
    if len(name) > max_len:
        name = name[:max_len].strip()
    return name or "douyin_video"


def download_video(video_url, title, author, aweme_id, output_dir, use_doh=True):
    """下载视频到本地, 返回保存路径。"""
    os.makedirs(output_dir, exist_ok=True)
    base = sanitize_filename(title)
    if author:
        base = f"{sanitize_filename(author)}_{base}"
    path = os.path.join(output_dir, f"{base}.mp4")
    counter = 2
    while os.path.exists(path):
        path = os.path.join(output_dir, f"{base}_{counter}.mp4")
        counter += 1

    print(f"  开始下载 -> {os.path.basename(path)}")

    headers = {
        "User-Agent": MOBILE_UA,
        "Referer": HOMEPAGE_URL,
        "Range": "bytes=0-",
    }
    final_url, status, resp_headers, _ = http_get(
        video_url, headers=headers, use_doh=use_doh, allow_redirects=True,
    )

    # 视频地址会 302 跳转到 CDN, 需对最终地址发起带 Range 的流式下载
    total = None
    # 用流式: 手动建立连接, 边读边写
    parsed = urlparse(final_url)
    host = parsed.hostname
    port = parsed.port or 443
    ips = doh_resolve(host) if use_doh else []
    if not ips:
        ips = [host]
    path_req = parsed.path or "/"
    if parsed.query:
        path_req += "?" + parsed.query

    last_err = None
    for ip in ips:
        try:
            conn = _connect_https(ip, port, host, 30)
            conn.request("GET", path_req, headers={
                "Host": host, "User-Agent": MOBILE_UA,
                "Referer": HOMEPAGE_URL, "Range": "bytes=0-",
            })
            resp = conn.getresponse()
            if resp.status not in (200, 206):
                conn.close()
                last_err = ValueError(f"CDN 返回 HTTP {resp.status}")
                continue
            total = resp.getheader("Content-Length")
            total = int(total) if total else None

            downloaded = 0
            chunk = 64 * 1024
            start = time.time()
            with open(path, "wb") as f:
                while True:
                    buf = resp.read(chunk)
                    if not buf:
                        break
                    f.write(buf)
                    downloaded += len(buf)
                    if total:
                        pct = downloaded * 100 / total
                        speed = downloaded / max(time.time() - start, 1e-6) / 1024
                        sys.stdout.write(
                            f"\r  进度: {pct:5.1f}%  "
                            f"{downloaded / 1048576:.2f}/{total / 1048576:.2f} MB  "
                            f"{speed:.0f} KB/s"
                        )
                        sys.stdout.flush()
            sys.stdout.write("\n")
            conn.close()
            return path
        except Exception as e:
            last_err = e
            continue

    raise RuntimeError(f"下载失败: {last_err}")


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------

def _extract_meta(data):
    """从解析数据中提取标题、作者等元信息。"""
    found = {}
    _walk_find(data, found)
    return {
        "title": found.get("title"),
        "author": found.get("author"),
    }


def run(text, output_dir, info_only=False, use_doh=True, quality=None):
    # 1. 提取链接
    url = extract_url(text)
    print(f"[1/4] 提取到链接: {url}")

    # 2. 解析 aweme_id
    aweme_id = get_aweme_id(url, use_doh=use_doh)
    print(f"[2/4] 视频 ID: {aweme_id}")

    # 3. 抓分享页, 解析清晰度列表
    html = fetch_share_page(aweme_id, use_doh=use_doh)
    data = extract_router_data(html)
    if not data:
        debug_path = os.path.join(output_dir, f"debug_{aweme_id}.html")
        os.makedirs(output_dir, exist_ok=True)
        with open(debug_path, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"[!] 未能解析页面数据, 已保存原始 HTML 到 {debug_path}")
        return None

    qualities = get_all_qualities(data)
    meta = _extract_meta(data)
    if not qualities:
        print("[!] 未能找到视频地址。")
        debug_path = os.path.join(output_dir, f"debug_{aweme_id}.json")
        with open(debug_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"    已保存 JSON 到 {debug_path}")
        return None

    title = meta.get("title") or aweme_id
    author = meta.get("author", "")
    print(f"[3/4] 标题: {title}")
    if author:
        print(f"       作者: {author}")
    print("       可选清晰度:")
    for q in qualities:
        print(f"         - {q['label']} (ratio={q['ratio']})")

    # 选定要下载的清晰度
    chosen = None
    if quality:
        for q in qualities:
            if q["ratio"] == quality or q["label"] == quality:
                chosen = q
                break
        if not chosen:
            print(f"[!] 未找到清晰度 {quality}, 改用默认 720p")
    if not chosen:
        # 默认 720p
        for q in qualities:
            if q["ratio"] == "720p":
                chosen = q
                break
        if not chosen:
            chosen = qualities[0]

    video_url = chosen["url"]
    print(f"       下载清晰度: {chosen['label']}")

    if info_only:
        print("[4/4] --info 模式, 跳过下载。")
        return video_url

    # 4. 下载
    print("[4/4] 开始下载...")
    path = download_video(video_url, title, author, aweme_id, output_dir, use_doh=use_doh)
    print(f"完成! 已保存到: {path}")
    return path


def main():
    parser = argparse.ArgumentParser(
        description="抖音无水印视频下载工具 (零依赖, 内置 DoH 绕过 DNS 污染)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            '  python3 douyin_download.py "https://v.douyin.com/xxxxx/"\n'
            '  python3 douyin_download.py "链接" --quality 1080p   # 指定清晰度\n'
            '  python3 douyin_download.py "链接" --info            # 查看可选清晰度\n'
        ),
    )
    parser.add_argument("input", help="抖音分享文本或视频链接")
    parser.add_argument("-o", "--output", default="./downloads", help="保存目录 (默认 ./downloads)")
    parser.add_argument("--info", action="store_true", help="仅解析, 不下载")
    parser.add_argument(
        "--quality", default=None,
        help="下载清晰度: 1080p / 720p / 540p (默认 720p)",
    )
    parser.add_argument("--no-doh", action="store_true", help="关闭 DoH (本地 DNS 正常时用)")
    args = parser.parse_args()

    try:
        result = run(
            args.input, args.output, args.info,
            use_doh=not args.no_doh, quality=args.quality,
        )
        if not result:
            sys.exit(1)
    except ValueError as e:
        print(f"[错误] {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(f"[错误] {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
