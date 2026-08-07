# Family Health & Shield

一个纯前端(无后端服务器)的家庭健康档案 + 保险管理工具,支持:

- 🔒 全屏锁屏 + 密码/AES-256-GCM 本地加密(`appLockScreen`,基于 PBKDF2 派生密钥)
- 🫆 指纹 / Face ID / Touch ID 解锁(WebAuthn PRF 扩展,逐设备绑定)
- 🗄️ IndexedDB 加解密存储(附件照片/PDF 静态加密,`idbPut` / `idbGet`)
- 📦 Pack ZIP 备份(开启加密时,备份 JSON + `attachments/` 内所有文件均整体加密)
- 📱 PWA:可安装到主屏幕、Service Worker 离线缓存、Web App Manifest

所有数据(健康记录、保险单、附件)都只保存在**用户自己浏览器的 localStorage / IndexedDB** 里,没有任何后端服务器或云端同步 —— 这也是这个项目可以直接用 GitHub Pages 白嫖静态托管的原因。

## 目录结构

```
family-health-shield/
├── index.html              ← 主应用页面(结构 + 样式)
├── app.js                   ← 主应用逻辑(原先内联在 index.html 里,现已拆成外部文件)
├── manifest.json            ← Web App Manifest(可安装为 PWA)
├── service-worker.js        ← 离线缓存(App Shell 预缓存 + cache-first)
├── icons/
│   ├── icon-16.png / icon-32.png     ← 浏览器标签页图标
│   ├── icon-180.png                  ← iOS "添加到主屏幕" 图标
│   ├── icon-192.png / icon-512.png   ← 标准 PWA 图标
│   ├── icon-maskable-192.png / -512.png ← Android 自适应图标(安全区留白)
│   ├── icon-source.svg               ← 图标源文件(标准版)
│   └── icon-maskable-source.svg      ← 图标源文件(maskable 版)
├── favicon.ico
└── README.md
```

## 上传到 GitHub

```bash
cd family-health-shield
git init
git add .
git commit -m "Initial commit: Family Health & Shield PWA"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

## 用 GitHub Pages 免费部署(推荐,天然 HTTPS,Service Worker 才能生效)

1. 仓库页面 → **Settings → Pages**
2. **Source** 选择 `Deploy from a branch`,Branch 选 `main` / `/(root)`,保存
3. 等 1~2 分钟,访问 `https://<你的用户名>.github.io/<仓库名>/` 即可
4. 手机浏览器打开该地址后,选择"添加到主屏幕"(iOS Safari)或浏览器会自动弹出"安装应用"提示(Android Chrome),即可像原生 App 一样使用,并支持离线打开

> ⚠️ Service Worker 只在 **HTTPS** 或 `localhost` 下才会注册生效,直接双击打开本地 `index.html`(`file://` 协议)可以正常使用 App 本身,但离线缓存/PWA 安装功能不会生效 —— 这是浏览器的安全限制,不是 bug。本地调试可以用 `python3 -m http.server` 之类的方式起一个 `http://localhost` 服务器测试。

## 更新部署后如何让访客拿到最新版本

`service-worker.js` 顶部有一行:

```js
const CACHE_VERSION = 'v1';
```

**每次你修改了 `index.html` / `manifest.json` / 图标等任何文件并重新 push 后,把这个版本号改一下**(比如改成 `'v2'`),否则老用户的浏览器会因为离线缓存而看到旧版本,直到缓存自然过期。

## 修改了 `app.js` 之后

应用逻辑现在是独立的 `app.js` 文件,CSP 用 `script-src 'self'` 直接放行,不再依赖哈希白名单(曾经用过 `sha256-...` 哈希锁定内联 `<script>`,但本地算好的哈希在 push 到 GitHub Pages 后经常和线上文件字节对不上,导致整个 App 白屏——具体原因见 `index.html` 头部的设计说明注释)。

**所以现在改 `app.js` 不需要额外步骤**,和改 `index.html` / `manifest.json` 一样,记得同步更新下面这条的 `CACHE_VERSION`,并且部署时要把 `app.js` 和 `index.html` 一起 push——只推 `index.html` 会导致线上白屏(`index.html` 会去请求一个不存在的 `app.js`)。

`scripts/update_csp_hash.py` 和 `.githooks/pre-commit` 是旧哈希方案留下的维护脚本,现在用不上了,可以删除。

## 版本号(右下角小徽章)

右下角有个小版本徽章(`#versionBadge`),锁屏状态下**不用先解锁**也能看到——它只是告诉你"这一份部署的是哪个版本",跟 Service Worker 缓存了什么、浏览器实际在跑什么,是两回事。

- 徽章显示的文字来自 `app.js` 顶部的 `APP_VERSION` / `APP_VERSION_DATE`,纯展示用,不影响任何缓存逻辑。
- `service-worker.js` 里的 `CACHE_VERSION` 是另一个独立的号,决定访客实际拿到的是不是最新文件。
- **这两个号不会自动同步**(分别在两个文件里),每次部署时手动一起改,两个文件顶部都留了互相指向的提醒注释。
- 部署后如果看到的版本号和你预期的不一样,**不代表部署失败**,而是提示你该硬刷新(Ctrl/Cmd+Shift+R)或去devtools清一下这个网站的 Service Worker/缓存了。

## 安全说明(务必阅读)

- 密码**没有找回机制**。忘记密码,已加密的附件和数据将无法恢复。
- 指纹/Face ID 解锁是**逐设备**的便捷登录方式,底层仍然依赖同一把密码派生出的密钥——生物识别只是替你在本机安全地"记住并按下密码"这一步,并不是比密码更强的独立加密层,也不能跨设备使用。
- 这是一个纯客户端应用,没有服务器,请自行确保设备本身的安全(锁屏、系统账户密码等),因为浏览器本地存储在设备层面通常没有额外保护。
