/**
 * dsh-scorpio 客户端样式 —— 暗色优先的「剧场感」设计系统：
 * 近黑画布 + 分层台面 + 发丝描边 + 单一强调色（天蝎红）+ 少量金铜点缀，
 * 数字与骰面一律等宽字体并做 tabular-nums；light/dark 两套 token 对称实现，
 * 由根节点的 data-theme 切换（默认跟随系统）。所有类名以 `.sc-` 作用域前缀，
 * 注入为一个 <style> 元素，重复挂载不会重复插入。
 */
export const SCORPIO_CSS = `
.sc-root{
--sc-bg:#f4f4f6;--sc-bg2:#e9eaee;--sc-card:#ffffff;--sc-card2:#f3f4f7;--sc-hover:#eef0f4;
--sc-border:#e1e3e9;--sc-border-strong:#c9ccd5;
--sc-text:#141519;--sc-dim:#4a5060;--sc-muted:#71778a;
--sc-accent:#c0392b;--sc-accent-hover:#a5301f;--sc-accent-soft:rgba(192,57,43,.10);--sc-ring:rgba(192,57,43,.32);
--sc-gold:#a67c2e;--sc-gold-soft:rgba(166,124,46,.12);
--sc-ok:#0e8f5c;--sc-warn:#b7791f;--sc-err:#c0392b;
--sc-ok-bg:rgba(14,143,92,.10);--sc-warn-bg:rgba(183,121,31,.12);--sc-err-bg:rgba(192,57,43,.10);
--sc-mask:rgba(15,17,20,.42);
/* 卡片底色以 RGB 分量给出，配合 --sc-float-alpha 组成 rgba()，让不透明度可运行时调节 */
--sc-card-rgb:255,255,255;--sc-card2-rgb:243,244,247;--sc-border-rgb:225,227,233;
--sc-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--sc-shadow-sm:0 1px 2px rgba(16,24,40,.06);
--sc-shadow-lg:0 1px 2px rgba(16,24,40,.06),0 16px 40px rgba(16,24,40,.16);
color-scheme:light;background:var(--sc-bg);color:var(--sc-text);
font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
letter-spacing:-0.004em;
/* 宿主面板给的是一块普通容器：这里只用 flex 列布局，不声明 100% 高度
   （100% 会在少数宿主布局里算成 0 或撑破父容器），溢出由 .sc-body 自己处理。 */
display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.sc-root[data-theme=dark]{
--sc-bg:#0c0c0e;--sc-bg2:#131317;--sc-card:#16161a;--sc-card2:#1c1c21;--sc-hover:#232329;
--sc-border:#2a2a31;--sc-border-strong:#3b3b45;
--sc-text:#f2f2f4;--sc-dim:#c3c6cf;--sc-muted:#8b8f9c;
--sc-accent:#e05a45;--sc-accent-hover:#f0705a;--sc-accent-soft:rgba(224,90,69,.15);--sc-ring:rgba(224,90,69,.42);
--sc-gold:#d8ab5a;--sc-gold-soft:rgba(216,171,90,.14);
--sc-ok:#38b980;--sc-warn:#e0b357;--sc-err:#e5604c;
--sc-ok-bg:rgba(56,185,128,.13);--sc-warn-bg:rgba(224,179,87,.14);--sc-err-bg:rgba(229,96,76,.13);
--sc-mask:rgba(0,0,0,.58);--sc-card-rgb:22,22,26;--sc-card2-rgb:28,28,33;--sc-border-rgb:42,42,49;
--sc-shadow-sm:0 1px 0 rgba(255,255,255,.03);
--sc-shadow-lg:0 1px 0 rgba(255,255,255,.03),0 18px 50px rgba(0,0,0,.6)}
.sc-root *{box-sizing:border-box}
.sc-root button{font:inherit;color:inherit;background:none;border:none;padding:0;cursor:pointer}
.sc-root input,.sc-root select,.sc-root textarea{font:inherit;color:var(--sc-text);background:var(--sc-card);border:1px solid var(--sc-border);border-radius:8px;padding:5px 9px;outline:none;width:100%;min-width:0;max-width:100%}
.sc-root input:focus,.sc-root select:focus,.sc-root textarea:focus{border-color:var(--sc-accent);box-shadow:0 0 0 3px var(--sc-ring)}
.sc-root ::placeholder{color:var(--sc-muted)}
.sc-root code{font-family:var(--sc-mono);font-size:11.5px;background:var(--sc-card2);border:1px solid var(--sc-border);border-radius:5px;padding:0 4px}
.sc-scroll{overflow:auto;scrollbar-width:thin}
.sc-scroll::-webkit-scrollbar{width:9px;height:9px}
.sc-scroll::-webkit-scrollbar-thumb{background:var(--sc-border-strong);border-radius:5px;border:2px solid transparent;background-clip:padding-box}
.sc-scroll::-webkit-scrollbar-track{background:transparent}

/* ── 顶栏 ───────────────────────────────────────────────── */
.sc-top{flex:0 0 auto;border-bottom:1px solid var(--sc-border);background:linear-gradient(180deg,var(--sc-card2),var(--sc-bg));padding:9px 11px 10px}
.sc-top-row{display:flex;align-items:center;gap:8px;min-height:20px}
.sc-brand{display:flex;align-items:center;gap:7px;font-weight:650;font-size:12.5px;letter-spacing:-.2px}
.sc-brand .sc-mark{width:18px;height:18px;flex:none;display:grid;place-items:center;border-radius:6px;background:var(--sc-accent-soft);border:1px solid var(--sc-accent);color:var(--sc-accent);font-size:11px;line-height:1}
.sc-spacer{flex:1}
.sc-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:11px;line-height:17px;border:1px solid var(--sc-border);background:var(--sc-card);color:var(--sc-muted);white-space:nowrap}
.sc-chip[data-tone=ok]{color:var(--sc-ok);background:var(--sc-ok-bg);border-color:transparent}
.sc-chip[data-tone=warn]{color:var(--sc-warn);background:var(--sc-warn-bg);border-color:transparent}
.sc-chip[data-tone=err]{color:var(--sc-err);background:var(--sc-err-bg);border-color:transparent}
.sc-chip[data-tone=gold]{color:var(--sc-gold);background:var(--sc-gold-soft);border-color:transparent}
.sc-steps{display:flex;align-items:center;gap:5px;margin-top:8px;flex-wrap:wrap}
.sc-step{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;border:1px dashed var(--sc-border-strong);color:var(--sc-muted);background:transparent}
.sc-step[data-on=true]{border-style:solid;border-color:var(--sc-accent);color:var(--sc-accent);background:var(--sc-accent-soft);font-weight:600}
.sc-step[data-done=true]{border-style:solid;border-color:var(--sc-ok);color:var(--sc-ok);background:var(--sc-ok-bg)}

/* ── 页签 ───────────────────────────────────────────────── */
.sc-tabs{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:8px 11px;border-bottom:1px solid var(--sc-border);background:var(--sc-bg2);overflow-x:auto;scrollbar-width:none}
.sc-tabs::-webkit-scrollbar{display:none;height:0}
.sc-tabs{scrollbar-width:none}
.sc-tab{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;min-height:29px;padding:0 12px;font-size:12px;color:var(--sc-dim);background:var(--sc-card);border:1px solid var(--sc-border);border-radius:8px;white-space:nowrap;transition:background .12s,color .12s,border-color .12s}
.sc-tab:hover{color:var(--sc-text);background:var(--sc-hover);border-color:var(--sc-border-strong)}
.sc-tab[data-on=true]{color:var(--sc-text);font-weight:600;background:var(--sc-accent-soft);border-color:var(--sc-accent)}
.sc-tab .sc-count{font-family:var(--sc-mono);font-size:10.5px;color:var(--sc-muted)}
.sc-tab[data-on=true] .sc-count{color:var(--sc-accent)}

/* ── 主体 ───────────────────────────────────────────────── */
.sc-body{flex:1 1 auto;min-height:0;min-width:0;padding:10px;display:flex;flex-direction:column;gap:9px;overflow:auto;overscroll-behavior:contain}
.sc-sec{background:var(--sc-card);border:1px solid var(--sc-border);border-radius:12px;box-shadow:var(--sc-shadow-sm);display:flex;flex-direction:column;min-width:0}
.sc-sec > .sc-sec-head{flex:0 0 auto}
.sc-sec-head{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--sc-border);background:var(--sc-card2)}
.sc-sec-title{font-weight:620;font-size:12.5px;letter-spacing:-.15px}
.sc-sec-body{padding:10px;display:flex;flex-direction:column;gap:8px;min-width:0}
.sc-hint{color:var(--sc-muted);font-size:11.5px;line-height:1.6}
.sc-note{color:var(--sc-muted);font-size:11.5px}
.sc-empty{padding:18px 12px;text-align:center;color:var(--sc-muted);font-size:12px;border:1px dashed var(--sc-border-strong);border-radius:10px;background:var(--sc-bg2)}
.sc-row{display:flex;align-items:center;gap:8px}
.sc-row-wrap{flex-wrap:wrap}
.sc-grid{display:grid;gap:8px}
.sc-grid[data-cols="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.sc-grid[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.sc-divider{height:1px;background:var(--sc-border);margin:2px 0}
.sc-body > .sc-sec + .sc-sec{margin-top:0}
.sc-body > .sc-sec-body-hint{padding:0 2px}
.sc-kv{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
.sc-kv .sc-k{color:var(--sc-muted);font-size:11.5px;flex:none}
.sc-kv .sc-v{font-variant-numeric:tabular-nums;text-align:right;word-break:break-word}

/* ── 按钮 ───────────────────────────────────────────────── */
.sc-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:0 11px;border:1px solid var(--sc-border);border-radius:8px;background:var(--sc-card);color:var(--sc-dim);font-size:12px;white-space:nowrap;transition:background .12s,color .12s,border-color .12s}
.sc-btn:hover{color:var(--sc-text);background:var(--sc-hover);border-color:var(--sc-border-strong)}
.sc-btn:disabled{opacity:.45;cursor:not-allowed}
.sc-btn[data-variant=primary]{background:var(--sc-accent);border-color:var(--sc-accent);color:#fff;font-weight:600}
.sc-btn[data-variant=primary]:hover{background:var(--sc-accent-hover);border-color:var(--sc-accent-hover);color:#fff}
.sc-btn[data-variant=ghost]{background:transparent;border-color:transparent;color:var(--sc-muted)}
.sc-btn[data-variant=ghost]:hover{background:var(--sc-hover);color:var(--sc-text)}
.sc-btn[data-size=sm]{min-height:24px;padding:0 8px;font-size:11.5px}
.sc-btn[data-tone=danger]{color:var(--sc-err)}
.sc-btn[data-tone=danger]:hover{background:var(--sc-err-bg);border-color:transparent;color:var(--sc-err)}

/* ── 列表 ───────────────────────────────────────────────── */
.sc-list{display:flex;flex-direction:column;gap:6px}
.sc-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--sc-border);border-radius:9px;background:var(--sc-card);transition:border-color .12s,background .12s;min-width:0;flex-wrap:wrap}
.sc-item:hover{border-color:var(--sc-border-strong);background:var(--sc-hover)}
.sc-item[data-active=true]{border-color:var(--sc-accent);background:var(--sc-accent-soft)}
.sc-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sc-item-name{font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-item-meta{color:var(--sc-muted);font-size:11px;font-family:var(--sc-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-file{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid transparent;border-radius:8px;font-size:11.5px}
.sc-file:hover{background:var(--sc-hover)}
.sc-file .sc-file-rel{flex:1 1 auto;min-width:0;font-family:var(--sc-mono);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 属性 / 技能格 ─────────────────────────────────────── */
.sc-attrs{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:7px;min-width:0}
.sc-attr{border:1px solid var(--sc-border);border-radius:9px;padding:6px 8px;background:var(--sc-card);display:flex;flex-direction:column;gap:3px}
.sc-attr[data-pending=true]{border-color:var(--sc-warn);background:var(--sc-warn-bg)}
.sc-attr-label{font-size:11px;color:var(--sc-muted);display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-attr[data-pending=true] .sc-attr-label{color:var(--sc-warn)}
.sc-attr-input{border:none!important;background:transparent!important;padding:0!important;font-family:var(--sc-mono);font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;box-shadow:none!important}
.sc-attr-input:focus{box-shadow:none!important}
.sc-attr-note{font-size:10.5px;color:var(--sc-muted);font-family:var(--sc-mono)}
.sc-group-title{font-size:11px;color:var(--sc-gold);letter-spacing:.04em;font-weight:600;margin-top:2px}

/* ── 槽位（物品/队友/宠物/随从） ─────────────────────────── */
.sc-slots{display:flex;flex-direction:column;gap:6px}
.sc-slot{display:flex;align-items:flex-start;gap:7px;padding:7px 9px;border:1px solid var(--sc-border);border-radius:9px;background:var(--sc-card);min-width:0;flex-wrap:wrap}
.sc-slot[data-off=true]{opacity:.55}
.sc-slot-name{flex:1;min-width:0}
.sc-slot-name input{font-weight:600}
.sc-slot-tags{display:flex;gap:5px;align-items:center}

/* ── 骰子 ───────────────────────────────────────────────── */
.sc-dice-verdict{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:10px;border:1px solid var(--sc-border);background:var(--sc-card2);font-weight:600;font-size:12.5px}
.sc-dice-verdict[data-outcome=success]{border-color:transparent;background:var(--sc-ok-bg);color:var(--sc-ok)}
.sc-dice-verdict[data-outcome=critical-success]{border-color:transparent;background:var(--sc-gold-soft);color:var(--sc-gold)}
.sc-dice-verdict[data-outcome=failure]{border-color:transparent;background:var(--sc-err-bg);color:var(--sc-err)}
.sc-dice-verdict[data-outcome=critical-failure]{border-color:transparent;background:var(--sc-err-bg);color:var(--sc-err)}
.sc-dice-verdict[data-outcome=tie]{border-color:transparent;background:var(--sc-warn-bg);color:var(--sc-warn)}
.sc-faces{display:flex;flex-wrap:wrap;gap:5px}
.sc-face{min-width:26px;height:26px;padding:0 6px;display:inline-grid;place-items:center;border-radius:7px;border:1px solid var(--sc-border);background:var(--sc-card2);font-family:var(--sc-mono);font-size:12.5px;font-variant-numeric:tabular-nums}
.sc-face[data-kept=false]{opacity:.42;text-decoration:line-through}
.sc-face[data-max=true]{border-color:var(--sc-accent);color:var(--sc-accent);background:var(--sc-accent-soft)}
.sc-ledger{display:flex;flex-direction:column;gap:4px;font-family:var(--sc-mono);font-size:11px}
.sc-ledger-row{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:baseline;padding:4px 6px;border-radius:7px}
.sc-ledger-row:hover{background:var(--sc-hover)}
.sc-ledger-row .sc-when{color:var(--sc-muted);white-space:nowrap}
.sc-ledger-row .sc-what{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-ledger-row .sc-res{font-weight:600}
.sc-ledger-row .sc-res[data-outcome=success],.sc-ledger-row .sc-res[data-outcome=critical-success]{color:var(--sc-ok)}
.sc-ledger-row .sc-res[data-outcome=failure],.sc-ledger-row .sc-res[data-outcome=critical-failure]{color:var(--sc-err)}
.sc-ledger-row .sc-res[data-outcome=tie]{color:var(--sc-warn)}

/* ── markdown 渲染 ─────────────────────────────────────── */
.sc-md{display:flex;flex-direction:column;gap:7px;font-size:12.5px;line-height:1.7}
.sc-md h1,.sc-md h2,.sc-md h3,.sc-md h4{margin:6px 0 0;line-height:1.35;letter-spacing:-.2px}
.sc-md h1{font-size:16px;border-bottom:1px solid var(--sc-border);padding-bottom:5px}
.sc-md h2{font-size:14px;color:var(--sc-text)}
.sc-md h3{font-size:13px;color:var(--sc-dim)}
.sc-md h4{font-size:12px;color:var(--sc-muted)}
.sc-md p{margin:0}
.sc-md ul,.sc-md ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.sc-md li{line-height:1.65}
.sc-md blockquote{margin:0;padding:5px 10px;border-left:3px solid var(--sc-accent);background:var(--sc-accent-soft);border-radius:0 8px 8px 0;color:var(--sc-dim)}
.sc-md hr{border:none;border-top:1px solid var(--sc-border);margin:4px 0}
.sc-md table{border-collapse:collapse;width:100%;font-size:11.5px}
.sc-md th,.sc-md td{border:1px solid var(--sc-border);padding:4px 7px;text-align:left}
.sc-md th{background:var(--sc-card2);font-weight:600}
.sc-md pre{margin:0;padding:8px 10px;border:1px solid var(--sc-border);border-radius:8px;background:var(--sc-card2);overflow:auto;max-width:100%}
.sc-md pre code{background:none;border:none;padding:0;font-size:11.5px;line-height:1.6}
.sc-md strong{font-weight:650;color:var(--sc-text)}
.sc-md em{color:var(--sc-dim)}

/* ── 文本域 / 编辑器 ───────────────────────────────────── */
.sc-editor{font-family:var(--sc-mono);font-size:11.5px;line-height:1.65;min-height:260px;resize:vertical}
/* 正文视图：不设自己的最大高度/滚动条 —— 由 .sc-body 统一滚动。
   （此前叠了 .sc-scroll 的 overflow:auto + max-height，导致代码块被裁成一行。） */
.sc-preview{overflow:visible;max-height:none}
.sc-md{min-width:0;overflow-wrap:anywhere}

/* 元信息横排 */
.sc-meta{display:flex;flex-wrap:wrap;gap:5px 7px;min-width:0}
.sc-meta-item{display:inline-flex;align-items:baseline;gap:5px;padding:2px 8px;border-radius:999px;background:var(--sc-card2);border:1px solid var(--sc-border);font-size:11px;max-width:100%;min-width:0}
.sc-meta-k{color:var(--sc-muted);flex:none}
.sc-meta-v{font-family:var(--sc-mono);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:26ch}
.sc-md table{display:block;overflow-x:auto;max-width:100%}

/* ── 提示条 ─────────────────────────────────────────────── */
.sc-banner{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:9px;font-size:11.5px;line-height:1.6}
.sc-banner[data-tone=err]{background:var(--sc-err-bg);color:var(--sc-err)}
.sc-banner[data-tone=warn]{background:var(--sc-warn-bg);color:var(--sc-warn)}
.sc-banner[data-tone=ok]{background:var(--sc-ok-bg);color:var(--sc-ok)}
.sc-banner[data-tone=info]{background:var(--sc-accent-soft);color:var(--sc-accent)}
.sc-banner .sc-banner-text{flex:1;min-width:0;word-break:break-word}

/* ── 窄面板收口（右侧面板被拖窄时不留溢出、不挤字） ───────────────── */
@container (max-width: 340px){
.sc-attrs{grid-template-columns:repeat(auto-fill,minmax(84px,1fr))}
.sc-tab{padding:0 9px;font-size:11.5px}
.sc-step{padding:2px 7px;font-size:10.5px}
.sc-sec-body{padding:9px}
.sc-body{padding:8px;gap:7px}
.sc-btn{padding:0 9px}
.sc-slot{padding:6px 8px}
}
@media (max-width: 900px){
.sc-attrs{grid-template-columns:repeat(auto-fill,minmax(84px,1fr))}
.sc-tabs{gap:5px}
.sc-tab{padding:0 9px;font-size:11.5px}
}
/* 长路径 / 长名单一律可截断，绝不撑破面板 */
.sc-item-name,.sc-item-meta,.sc-file-rel,.sc-kv .sc-v,.sc-slot-name input{min-width:0}
.sc-kv{gap:6px}
.sc-kv .sc-v{max-width:62%}

/* ── 开局序章提示条（把「面板已解锁」与「还不能开演」分开说） ── */
.sc-readiness{flex:0 0 auto;margin:0 10px 8px;padding:8px 10px;display:flex;flex-direction:column;gap:7px;
  background:var(--sc-card2);border:1px solid var(--sc-border);border-radius:10px}
.sc-readiness-head{display:flex;align-items:center;gap:6px}
.sc-readiness-steps{display:flex;flex-wrap:wrap;gap:5px}
.sc-readiness-step{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:11px;
  border:1px solid var(--sc-border-strong);background:var(--sc-card);color:var(--sc-muted);cursor:pointer}
.sc-readiness-step[data-done=true]{border-color:transparent;background:var(--sc-ok-bg);color:var(--sc-ok)}
.sc-readiness-step[data-done=false]:hover{border-color:var(--sc-accent);color:var(--sc-accent);background:var(--sc-accent-soft)}
.sc-readiness-next{font-size:11.5px;color:var(--sc-dim);line-height:1.5}

/* ── 悬浮判定卡（shell.overlay）─────────────────────────── */
/* 浮层本身是 click-through 的，所以卡片必须自己 opt-in 指针事件。 */
.sc-float{
  /* 半透明底：--sc-float-alpha 由悬浮卡上的滑杆实时写入（默认 0.82），
     毛玻璃靠 backdrop-filter 兜住底下的内容，保证半透明时文字依然可读。 */
  --sc-float-alpha:.82;
  position:fixed;z-index:80;width:340px;max-width:calc(100vw - 24px);display:flex;flex-direction:column;
  background:rgba(var(--sc-card-rgb),var(--sc-float-alpha));
  backdrop-filter:blur(14px) saturate(1.25);-webkit-backdrop-filter:blur(14px) saturate(1.25);
  border:1px solid rgba(var(--sc-border-rgb),.9);border-radius:12px;
  box-shadow:var(--sc-shadow-lg);pointer-events:auto;overflow:hidden;color:var(--sc-text);
  font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Inter","PingFang SC","Microsoft YaHei",sans-serif}
.sc-float *{box-sizing:border-box}
.sc-float-min{width:auto;border-radius:999px}
.sc-float-btn{width:44px;height:44px;border-radius:999px;font-size:20px;line-height:1;display:grid;place-items:center;
  background:var(--sc-accent);color:#fff;box-shadow:var(--sc-shadow-lg)}
.sc-float-btn:hover{background:var(--sc-accent-hover)}
.sc-float-head{display:flex;align-items:center;gap:6px;padding:6px 8px;
  background:rgba(var(--sc-card2-rgb),calc(var(--sc-float-alpha) * .92));
  border-bottom:1px solid rgba(var(--sc-border-rgb),.85);cursor:grab;touch-action:none;user-select:none}
.sc-float-head:active{cursor:grabbing}
.sc-float-grip{color:var(--sc-muted);font-size:12px;letter-spacing:-1px}
.sc-float-title{font-weight:650;font-size:12.5px}
.sc-float-body{display:flex;flex-direction:column;gap:7px;padding:9px;max-height:min(62vh,540px);overflow:auto}

/* 透明度滑杆：只在卡内可见，拖动即时改变 --sc-float-alpha */
.sc-float-alpha{display:flex;align-items:center;gap:6px;padding:0 0 2px}
.sc-float-alpha-label{font-size:10.5px;color:var(--sc-muted);white-space:nowrap;font-variant-numeric:tabular-nums;min-width:52px}
.sc-float-alpha input[type=range]{flex:1;min-width:0;width:auto;height:16px;padding:0;border:none;background:transparent;
  accent-color:var(--sc-accent);cursor:pointer;box-shadow:none}
.sc-float-alpha input[type=range]:focus{box-shadow:none}
.sc-float-alpha-reset{border:none;background:transparent;color:var(--sc-muted);font-size:11px;cursor:pointer;padding:0 2px}
.sc-float-alpha-reset:hover{color:var(--sc-accent)}
.sc-float-body .sc-grid[data-cols="2"]{gap:6px}
.sc-float-result{display:flex;flex-direction:column;gap:6px;padding-top:2px;border-top:1px solid var(--sc-border)}
.sc-float-history{display:flex;flex-direction:column;gap:2px;padding-top:6px;border-top:1px solid var(--sc-border)}
.sc-float-hrow{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:baseline;font-size:11.5px}
.sc-float input,.sc-float select,.sc-float textarea{font:inherit;color:var(--sc-text);background:var(--sc-card);
  border:1px solid var(--sc-border);border-radius:8px;padding:4px 8px;outline:none;width:100%;min-width:0;max-width:100%}
.sc-float input:focus,.sc-float select:focus{border-color:var(--sc-accent);box-shadow:0 0 0 3px var(--sc-ring)}
.sc-float ::placeholder{color:var(--sc-muted)}

/* ── 工具类 ─────────────────────────────────────────────── */
.sc-mono{font-family:var(--sc-mono);font-variant-numeric:tabular-nums}
.sc-dim{color:var(--sc-dim)}
.sc-muted{color:var(--sc-muted)}
.sc-accent{color:var(--sc-accent)}
.sc-gold{color:var(--sc-gold)}
.sc-ok{color:var(--sc-ok)}
.sc-err{color:var(--sc-err)}
.sc-warn{color:var(--sc-warn)}
.sc-small{font-size:11px}
.sc-tiny{font-size:10.5px}
.sc-bold{font-weight:650}
.sc-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-nowrap{white-space:nowrap}
.sc-wrap{word-break:break-word}
.sc-hidden{display:none}
.sc-spin{display:inline-block;width:11px;height:11px;border:2px solid var(--sc-border-strong);border-top-color:var(--sc-accent);border-radius:50%;animation:sc-spin .7s linear infinite}
@keyframes sc-spin{to{transform:rotate(360deg)}}
`

const STYLE_ID = 'dsh-scorpio-styles'

/** 注入一次样式（重复调用是幂等的）。 */
export function ensureCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = SCORPIO_CSS
  document.head.appendChild(style)
}
