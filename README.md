# Family Health & Shield

一个纯前端(无后端服务器)的家庭健康档案 + 保险管理工具,支持:

- 🔒 全屏锁屏 + 密码/AES-256-GCM 本地加密(`appLockScreen`,基于 PBKDF2 派生密钥)
- 🫆 指纹 / Face ID / Touch ID 解锁(WebAuthn PRF 扩展,逐设备绑定)
- 🗄️ IndexedDB 加解密存储(附件照片/PDF 静态加密,`idbPut` / `idbGet`)
- 📦 Pack ZIP 备份(开启加密时,备份 JSON + `attachments/` 内所有文件均整体加密)
- 📱 PWA:可安装到主屏幕、Service Worker 离线缓存、Web App Manifest

所有数据(健康记录、保险单、附件)都只保存在**用户自己浏览器的 localStorage / IndexedDB** 里,没有任何后端服务器或云端同步 —— 这也是这个项目可以直接用纯静态托管白嫖的原因(推荐 Cloudflare Pages,理由见下方部署章节)。

## 目录结构

```
family-health-shield/
├── index.html              ← 主应用页面(结构 + 样式)
├── app.js                   ← 主应用逻辑(原先内联在 index.html 里,现已拆成外部文件)
├── merge-engine.js           ← 单成员导入的字段/条目级合并引擎(纯函数,UMD 封装,浏览器/Node 双环境可用),设计详见 MERGE_SYNC_DESIGN.md
├── merge-engine.test.js      ← merge-engine.js 的 Node 测试(`node merge-engine.test.js` 直接跑,不需要额外装测试框架)
├── MERGE_SYNC_DESIGN.md      ← 单成员合并同步功能的完整设计文档(语义决定 + 实现细节两部分)
├── manifest.json            ← Web App Manifest(可安装为 PWA)
├── service-worker.js        ← 离线缓存(App Shell 预缓存 + cache-first)
├── _headers                  ← Cloudflare Pages 自定义响应头(CSP frame-ancestors / X-Frame-Options 等,GitHub Pages 不支持,故需换托管平台)
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

## 用 Cloudflare Pages 免费部署(推荐 —— 天然 HTTPS,而且支持自定义响应头)

这个项目存的是健康记录+保单这类敏感数据,所以选了支持自定义 HTTP 响应头的托管平台:仓库里的 `_headers` 文件能让 Cloudflare Pages 在每个响应上附加 `Content-Security-Policy: frame-ancestors 'none'` 和 `X-Frame-Options: DENY`,把点击劫持防护也补上(这一条 GitHub Pages 做不到,因为它不支持自定义响应头,见下方"安全说明")。

1. 用 GitHub 账号登录 [Cloudflare Pages](https://pages.cloudflare.com/)
2. **Create a project → Connect to Git**,选择这个仓库
3. Build 设置全部留空/默认即可 —— 这是纯静态文件,没有构建步骤(Build command 留空,Output directory 填 `/` 或留空)
4. 部署完成后会拿到一个 `https://<项目名>.pages.dev` 地址,之后每次 `git push` 都会自动重新部署
5. (可选)Cloudflare Pages 项目设置里可以绑定自己的域名
6. 手机浏览器打开该地址后,选择"添加到主屏幕"(iOS Safari)或浏览器会自动弹出"安装应用"提示(Android Chrome),即可像原生 App 一样使用,并支持离线打开

> ⚠️ Service Worker 只在 **HTTPS** 或 `localhost` 下才会注册生效,直接双击打开本地 `index.html`(`file://` 协议)可以正常使用 App 本身,但离线缓存/PWA 安装功能不会生效 —— 这是浏览器的安全限制,不是 bug。本地调试可以用 `python3 -m http.server` 之类的方式起一个 `http://localhost` 服务器测试。

### 备选:GitHub Pages(仅建议临时测试用,不建议长期存放这个 App)

步骤和以前一样(仓库 **Settings → Pages** → `Deploy from a branch` → `main` / `/(root)`),依然能正常跑,**但 GitHub Pages 不支持自定义响应头,`_headers` 文件在这里不会生效**,也就是说部署在 GitHub Pages 上时点击劫持防护这一层是缺失的。仅建议用来快速验证改动,正式长期使用请部署到 Cloudflare Pages。

## 更新部署后如何让访客拿到最新版本

`service-worker.js` 顶部有一行:

```js
const CACHE_VERSION = 'v1';
```

**每次你修改了 `index.html` / `manifest.json` / 图标等任何文件并重新 push 后,把这个版本号改一下**(比如改成 `'v2'`),否则老用户的浏览器会因为离线缓存而看到旧版本,直到缓存自然过期。

（`_headers` 是个例外:它不在 `service-worker.js` 的 `APP_SHELL` 缓存列表里,是 Cloudflare 边缘节点直接读取生效的,单独改它不需要跟着改 `CACHE_VERSION`。)

## 修改了 `app.js` 之后

应用逻辑现在是独立的 `app.js` 文件,CSP 用 `script-src 'self'` 直接放行,不再依赖哈希白名单(曾经用过 `sha256-...` 哈希锁定内联 `<script>`,但本地算好的哈希在 push 到 GitHub Pages 后经常和线上文件字节对不上,导致整个 App 白屏——具体原因见 `index.html` 头部的设计说明注释)。

**所以现在改 `app.js` 不需要额外步骤**,和改 `index.html` / `manifest.json` 一样,记得同步更新下面这条的 `CACHE_VERSION`,并且部署时要把 `app.js`、`merge-engine.js` 和 `index.html` 一起 push——只推 `index.html` 会导致线上白屏(`index.html` 会去请求不存在的 `app.js`/`merge-engine.js`)。

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
- 点击劫持防护:`_headers` 里的 `frame-ancestors 'none'` + `X-Frame-Options: DENY` 只有部署在 **Cloudflare Pages**(或其它支持自定义响应头的静态托管)上才会生效——这是 HTTP 响应头级别的保护,`_headers` 文件本身在 GitHub Pages 上会被直接忽略。
- CSP `style-src`(2026-08-10 起收紧为 `'self'` 加一个 `<style>` 块内容的哈希,不再有 `'unsafe-inline'`):主界面(index.html + app.js 渲染主界面的部分)原来约 285 处内联 `style="..."` 已全部改成预生成的 CSS class,详见 `index.html` 里 `<style>` 块末尾的注释和 CSP `<meta>` 上方的设计说明。**例外**:9 个打印/报告弹窗(BP 记录、用药清单、保单摘要等)仍然使用内联样式,但每个弹窗现在都在自己的文档里带了一份独立、明确写出来的 CSP `<meta>`(而不是隐式沿用或不受约束),细节见 app.js 里 `printEmergency` 函数上方的注释——这是刻意的范围划分,不是遗漏。
- ⚠️ **改 `index.html` 里 `<style>` 块的 CSS 之前必读**:style-src 现在靠一个精确到字节的 CSS 哈希放行主样式表,而不是笼统的 `'unsafe-inline'`。这意味着改动 `<style>` 块里任何一条规则(哪怕只加一行)都会让这个哈希失效——浏览器不会报错也不会降级,而是直接整体拒绝这份样式表,页面瞬间变成没有任何样式的纯文字(2026-08-10 上线时真实发生过一次,起因是收紧 CSP 时漏算了这一点)。**改完 CSS 后必须跑一次** `python3 regen-style-hash.py`,把打印出来的新哈希**同时**贴到两个地方:`index.html` 里 CSP `<meta>` 的 `style-src` 那一行,以及 `_headers` 文件里 `Content-Security-Policy` 的 `style-src` 那一段——两处必须完全一致,浏览器会取两份 CSP 的交集执行,漏改任何一处页面照样会裸奔。
- 第三方库是 vendor 进仓库的本地文件(`lib/jszip.min.js`、`lib/pdf.min.mjs` + `lib/pdf.worker.min.mjs`),不会跟着 npm 自动更新。建议**每季度手动检查一次**上游是否有新版本/安全公告(jszip: https://github.com/Stuk/jszip/releases ,pdf.js: https://github.com/mozilla/pdf.js/releases ),有的话下载新的 `.min.js`/`.min.mjs` 文件直接替换,不需要改代码(除非上游有 breaking change)。
- v23/v24(2026-08-12)安全加固:
  1. **导入备份文件的输入校验**:`normalizeImportedMembers()` 之前只把导入 JSON 里的各种 `.id` 字段做 `String()` 类型转换,没有校验内容;这些 id 又被多处 `innerHTML` 拼接时直接使用(没有 `escapeHtml()`,因为假设 id 一定是内部生成的安全字符串)。一份精心构造的备份文件因此可以把任意 HTML/脚本注入进渲染出的页面(尤其是 9 个打印弹窗,那里 CSP 允许内联脚本执行)。现在导入的 id 会先做白名单校验(`sanitizeId()`/`sanitizeIdsDeep()`),不合法就重新生成;导入的 `vitals` 数值字段也会跟手动录入表单一样做 `parseFloat()` 校验(`sanitizeVitals()`)。同时把所有 `.id` 拼接进 `innerHTML` 的地方(约 37 处)统一加上 `escapeHtml()` 作为纵深防御。
  2. **PBKDF2 迭代次数从 150,000 提升到 600,000**(`PBKDF2_CONFIGS` / `PBKDF2_ITER_VERSION`,对齐 OWASP 2026 年的建议下限)。已启用加密的旧设备首次解锁时会在后台自动完成一次性迁移(`migratePbkdf2Iterations()`):用当次输入的密码重新派生新密钥、重新加密所有附件和主数据,全部成功后才切换配置,任何一步失败都不会写入任何改动,下次解锁自动重试——迁移期间会用 `beforeunload` 提示不要关闭页面。
  3. `_headers` 增加 `Strict-Transport-Security` 和 `Cross-Origin-Opener-Policy: same-origin`。
  4. pdf.js 调用显式加上 `isEvalSupported: false`,即使当前 vendored 版本已修复相关 CVE,也作为纵深防御保留。
- v25(2026-08-13)修复 v23/v24 上线后发现的两个问题:
  1. **【严重,已修复】导入备份"密码错误"其实是密钥派生参数不匹配**:v23/v24 把 PBKDF2 迭代次数从 150,000 提到 600,000 后,导出的加密备份文件(JSON/ZIP)没有记录自己是用哪个迭代次数加密的——`buildExportPayload()` 写的 envelope 只有 `{salt, payload}`,没有 `iterVer`。结果任何在这次升级之前导出的备份文件,导入时会被新代码默认按 600,000 次去派生密钥,跟文件实际用的 150,000 次对不上,密码明明输对了也会被判定为"Incorrect passcode"。同样的问题也存在于生物识别启用时的密码校验(`enrollBiometric`)。现在 envelope 会记录 `iterVer`,导入时按文件自带的值派生;没有这个字段的旧文件按 legacy(150,000 次)处理,向后兼容。**如果你在 v23/v24 期间导出过备份,那些文件不受影响,用这个版本可以正常导入。**
  2. **新增:加密状态哨兵,防止未来任何原因导致的静默明文回退**:排查过程中确认了 app.js 里没有任何代码路径会自动关闭加密(唯一能关闭加密的入口是 Settings 里"Disable Encryption"按钮,需要先 `confirm()` 弹窗确认,还要求先用正确密码解锁成功),但为了防止*任何*原因(包括未来的 bug、极端情况下的浏览器存储异常)导致加密配置意外丢失后被静默当成"加密关闭"处理、直接把数据明文渲染出来且不提示,新增了一个独立记录"最近一次主动加密选择"的哨兵(`CRYPTO_INTENT_KEY`),只在两个地方写入:成功开启加密时写 `enabled`,完成上述确认过的关闭流程时写 `disabled`。`init()` 启动时如果发现"加密配置不见了,但上一次主动选择记录是 enabled",会先弹出明确警告再继续,而不是什么都不说就把数据摊开显示。
- v26(2026-08-13)【严重,已修复】已安装的桌面快捷方式反复打不开(`ERR_FAILED`):
  - **根因**:Cloudflare Pages 对静态站点有个文档化的默认行为——访问 `/index.html` 会自动 301/308 跳转到 `/`(GitHub Pages 不会这样)。而 `manifest.json` 的 `start_url` 原来写的是 `"./index.html"`,导致安装出来的桌面快捷方式每次启动都固定打开这个会被跳转的 URL。Service Worker 在 `install` 阶段 `cache.addAll([...,'./index.html',...])` 预缓存时,这个请求会**悄悄跟随**Cloudflare 的跳转,拿到的 `Response` 对象带着 `redirected: true` 却被存进了 `./index.html` 这个缓存键下。Chrome 有一条规范硬性规定:Service Worker **不允许**用一个"跳转过的" Response 去响应页面导航(navigation)请求——一旦这么做,整个页面加载直接失败,报错就是截图里看到的 `net::ERR_FAILED`。第一次打开(那时候 Service Worker 还没装上)能正常走完跳转、停在 `/`,所以在那个标签页里刷新一直没事;但桌面快捷方式每次都是全新启动、固定打 `/index.html` 这个已经被污染的缓存键,所以每次重开都会炸。
  - **修复**:①`manifest.json` 的 `start_url` 改成 `"./"`(新装的快捷方式从此不会再指向会跳转的 URL)。②`service-worker.js` 把 `'./index.html'` 从预缓存列表里整个拿掉,并且新增了一个专门处理"页面导航"请求的分支——不管实际请求的是 `/`、`/index.html` 还是别的路径,一律统一从唯一、干净的 `'./'` 缓存条目里回应,彻底不给 Cloudflare 那个跳转任何触发机会。这一条很关键:**已经装在桌面上的旧快捷方式不会因为这次部署自动改掉自己的启动 URL**(那是安装那一刻写死的),所以只改 `manifest.json` 治标不治本——真正让旧快捷方式也变好的是这条 Service Worker 层面的修复。
  - **如果你已经中招、快捷方式还在报错**:开一个普通的 Chrome 标签页(不要用桌面快捷方式),直接输入网址根路径(不要带 `/index.html`)打开一次——这次能正常加载,同时会在后台把 Service Worker 更新到这个修复版本。加载成功后确认右下角版本号变成 v26 或更新,再回去点桌面快捷方式,应该就正常了。如果还不行,打开 DevTools → Application → Service Workers,点 "Unregister"(这个操作**不会**清掉你的健康/保单数据,数据存在完全独立的 localStorage/IndexedDB 里),然后重新打开网址根路径让它重新安装一遍 Service Worker;最保险的做法是把桌面快捷方式整个卸载重装一次,让它用新版 `manifest.json` 里的 `"./"` 重新生成启动 URL。

  1. 保单 Ledger 编辑交易记录:点"编辑"以前不会自动滚动到表单(表单在列表上方),存完也不会滚回去定位到那条记录,列表长了很麻烦。现在点编辑会自动滚到表单,存完会自动滚回那条记录并短暂高亮,不用再手动上下找。
  2. Chrome 在存 Add Member 之类操作时弹出"是否保存密码"提示:根源是整个 App 里始终有 8 个 `type="password"` 的输入框常驻在 DOM 里(解锁、修改密码、导入导出密码等),哪怕当下没显示——Chrome 只要页面上存在这种输入框就可能触发保存密码提示,不需要 `<form>`,这些字段本来也不是网站登录密码,被 Chrome 密码管理器介入其实是误判。改成 `type="text"` 加 CSS(`-webkit-text-security`)做视觉遮罩,效果看起来还是圆点,但 Chrome 不会再当成登录密码框。
- v27(2026-08-14)锁屏/解锁屏加了大号触屏数字键盘:两个"输入现有密码"的界面(`appLockScreen` 的 `appLockPasscodeInput`、解锁弹窗的 `unlockPasscodeInput`)新增 `.numpad` 数字键盘,方便手机/平板输入。输入框本身加了 `inputmode="none"`,数字键盘按钮只会往 `input.value` 写字符、从不调用 `.focus()`,所以点数字键盘不会弹出系统输入法;因为密码不限制必须是数字(只要求 6 位以上),键盘旁边留了一个 ⌨️ 切换按钮,给密码里带字母/符号的人切回普通输入法。这次改动往 `index.html` 的 `<style>` 块里加了 numpad 的 CSS,按 README 前面"务必阅读"那条提醒跑了 `regen-style-hash.py` 重新生成了哈希并同步贴到了 `index.html` 和 `_headers` 两处。`APP_VERSION`/`APP_VERSION_DATE`(app.js)和 `CACHE_VERSION`(service-worker.js)都已同步改成 v27——上一版数字键盘功能虽然做了,但漏了这一步,导致老用户的浏览器会因为 Service Worker 缓存继续拿到没有数字键盘的旧版本;这一版已修正。
- v28(2026-09-07)附件(照片/PDF)预览弹窗改版,对齐了另一个姊妹项目(Ledger 记账本)里更成熟的查看器布局:①弹窗从固定 `max-width:720px` 改成 `95vw × 88vh`,尽量用满屏幕;②弹窗背景遮罩从浅色 `rgba(0,0,0,0.4)` 加深到 `rgba(0,0,0,0.85)`,看照片/PDF 时不刺眼;③修复一个实际存在的问题——原来标题、内容、"下载/关闭"按钮是整体一起滚动的,遇到多页 PDF 时按钮会被顶到最下面,得先滚到底才能点"关闭";现在改成标题和按钮固定不动,只有中间的内容区域自己滚动。顺带修了预览区域的排列方式:原来是默认的 `flex` 横向排列且 `overflow:hidden`,多页 PDF 的画布本该竖着一页页排开,结果理论上会被挤成一排还被裁掉看不到——改成 `flex-direction:column` 纵向堆叠、`overflow-y:auto` 允许滚动。这次改动改了 `index.html` 的 `<style>` 块(只涉及 `attachmentViewerModal` 专用的两个哈希类,没碰其他共用样式),已按提醒跑了 `regen-style-hash.py`,新哈希已同步贴进 `index.html` 和 `_headers` 两处。`APP_VERSION`/`APP_VERSION_DATE`(app.js)和 `CACHE_VERSION`(service-worker.js)已同步改成 v28。
- v29(2026-09-07)保单 Premium Ledger 的"付款方式"下拉菜单新增一项"Credit Card"(信用卡),插在 Auto-Debit 和 Cash 之间。这个字段在代码里只是存成自由文本(`l.method`)展示,没有任何按具体选项分支的图标/逻辑,所以只改了 `index.html` 里的 `<option>` 列表,没碰其他地方。这次改动不涉及 `<style>` 块,不需要重新生成 CSP 哈希。`APP_VERSION`/`APP_VERSION_DATE`(app.js)和 `CACHE_VERSION`(service-worker.js)已同步改成 v29。
- v32-v39(2026-09-17~18)**单个成员导入不再是整体覆盖,改成字段/条目级别的合并同步**——这是这几版里最大的一次数据模型改动,建议部署前完整看完这一条。

  **要解决的问题**:原来"导出单个成员 → 对方编辑 → 导入回主文件"这条路径,导入时是整个成员对象覆盖,哪怕只想同步对方新增的一条记录,自己这边同期做的任何修改都会被整份替换掉,没有任何合并逻辑,详细设计取舍记录在仓库里新增的 `MERGE_SYNC_DESIGN.md`。

  **新增的数据字段**(每个可同步的实体——成员、健康记录、提醒、保单及其名下的 Ledger/Rider/Coverage/Sum Insured History/Surrender Record/Claim——现在都带):
  - `version`:逻辑时钟(不是挂钟时间戳),每次本地编辑 +1,合并时取双方较大值
  - `deletedAt`:软删除标记,删除操作不再从数组里物理移除,只是标记,永久保留(不做自动物理清理)
  - `schemaVersion`:为以后字段结构迁移预留
  - 成员额外带 `fieldVersion`(姓名/血型/过敏史等标量字段各自独立计版本,两人分别改了不同字段不会互相覆盖)和 `historyEntries`(病史字段的底层从纯文本升级成带 id/version 的条目数组,但 v1 界面还是单段编辑,行为上感觉不出区别)

  **合并规则**(纯函数实现在新增的 `merge-engine.js` 里,`merge-engine.test.js` 有 67 条测试,含一轮随机模糊测试):数组类数据(记录、保单等)按 id 取并集;同一 id 版本不同,版本高的赢;版本相同但内容不同 → 判定为"冲突",不自动二选一,保留本机版本,把对方版本存进冲突队列等你确认。

  **新增的冲突处理界面**:发现冲突时,页头会出现"⚠️ Conflicts (N)"按钮,点开是一个列表,每条冲突显示"你这边 / 对方那边"的简要对比,可以选"保留我的" / "保留对方的" / (记录类条目可选)"两个都留着"(会复制一份新 id 的记录)。

  **删除行为的变化**:因为改成软删除,一台设备删掉的东西不会再在另一台设备重新导入时"复活"——但也意味着已删除的数据不会真的从存储里清空(只是不再显示),如果对隐私/存储空间比较敏感,导出的备份文件里仍然会带着这些标记为已删除的记录,只是主界面不显示。

  **升级注意事项(强烈建议)**:首次用这个版本打开 App 时,所有现存数据会被一次性打上 `version=1` 的标记(`migrateSyncFields()`,幂等,重复运行不会有副作用)。**如果家里有多台设备,建议升级后先让每台设备互相同步一次(导出/导入跑一轮),再继续各自编辑**——因为升级当天,各设备本地数据都是"从同一个起点开始计版本",如果升级前就存在尚未同步的分歧,这次升级不会自动帮你合并那些旧分歧,只会当作新的冲突处理,越早同步一次,冲突越少。

  **全量导出("Export All")的行为不变**,依然是整份覆盖,这次改动只影响"导出单个成员"这一条路径,详见 `MERGE_SYNC_DESIGN.md` 里的范围说明。

  这次改动新增了两个文件(`merge-engine.js`、`merge-engine.test.js`),`service-worker.js` 的预缓存列表(`APP_SHELL`)已加入 `merge-engine.js`,`index.html` 已在 `app.js` 之前加上对应的 `<script>` 标签。没有改 `<style>` 块,不需要重新生成 CSP 哈希。`APP_VERSION`/`APP_VERSION_DATE`(app.js)和 `CACHE_VERSION`(service-worker.js)已同步改成 v39。
