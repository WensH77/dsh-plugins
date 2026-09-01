window.__ModuleLoader__.load({
	id: "dsh-plugin-market",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useRef } = react;
		const h = react.createElement;

		// ── styles (injected once) ───────────────────────────────────────────
		const css = [
			// 区块容器：更宽松的纵向节奏，分隔段落
			".pm-section{max-width:820px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:18px;display:flex;padding:4px 2px}",
			".pm-section>h3{display:flex;align-items:center;gap:8px;margin:0;font-size:14px;font-weight:600;line-height:22px;letter-spacing:.01em}",
			".pm-section>h3::before{content:'';width:3px;height:14px;border-radius:2px;background:var(--dsw-alias-state-business-primary);opacity:.85}",
			".pm-section>h3:first-child{font-size:16px}",
			".pm-section>h3:first-child::before{height:16px}",
			".pm-intro{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}",
			".pm-message{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}",
			".pm-message[data-error=true]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-warn-tertiary)}",
			".pm-message[data-ok=true]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2)}",

			// 插件卡片：左侧状态色条 + 软阴影浮层
			".pm-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0;padding:0;list-style:none;display:grid}",
			".pm-row{position:relative;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;min-width:0;padding:12px 14px;flex-direction:column;gap:8px;display:flex;box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.06));transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease;overflow:hidden}",
			".pm-row::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-state-success-primary);opacity:.9;transition:opacity .18s ease}",
			".pm-row[data-enabled=false]::before{background:var(--dsw-alias-state-error-primary)}",
			".pm-row:hover{border-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-shadow-lv2,0 4px 14px rgba(0,0,0,.1));transform:translateY(-1px)}",
			".pm-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-caption);flex:none}",
			".pm-dot[data-enabled=true]{background:var(--dsw-alias-state-success-primary)}",
			".pm-dot[data-enabled=false]{background:var(--dsw-alias-state-error-primary)}",
			".pm-rowTop{align-items:center;gap:8px;display:flex}",
			".pm-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;letter-spacing:.01em}",
			".pm-tag{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 9px;font-size:11px;line-height:17px;flex:none;font-weight:500}",
			".pm-tag[data-enabled=true]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
			".pm-tag[data-disabled=true]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".pm-tag[data-pending=true]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}",
			".pm-tag.protected{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}",
			".pm-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;gap:10px;display:flex;align-items:center;flex-wrap:wrap;font-family:var(--dsw-font-mono)}",
			".pm-meta .pm-repo{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono)}",
			".pm-meta .pm-repoPath{white-space:normal;word-break:break-all;overflow-wrap:anywhere;min-width:0}",
			".pm-meta .pm-override{color:var(--dsw-alias-state-warn-primary);font-weight:600}",
			".pm-btns{gap:6px;display:flex;align-items:center;flex-wrap:wrap;margin-top:2px}",
			".pm-updateRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 0 2px}",

			// 按钮三档
			".pm-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);font:inherit;cursor:pointer;border-radius:7px;padding:4px 11px;font-size:12px;line-height:18px;flex:none;transition:border-color .15s ease,color .15s ease,background .15s ease,transform .12s ease}",
			".pm-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}",
			".pm-btn:active:not(:disabled){transform:scale(.97)}",
			".pm-btn:disabled{opacity:.45;cursor:default}",
			".pm-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-warn-tertiary)}",
			".pm-btn.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-state-warn-tertiary));color:var(--dsw-alias-state-error-primary)}",
			".pm-btn.primary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}",
			".pm-btn.primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-label-primary))}",
			".pm-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",

			// 输入与源管理
			".pm-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;border-radius:7px;padding:4px 8px;transition:border-color .15s ease}",
			".pm-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;border-radius:7px;padding:6px 11px;flex:1;min-width:0;transition:border-color .15s ease,box-shadow .15s ease}",
			".pm-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-alias-state-business-tertiary)}",
			".pm-input::placeholder{color:var(--dsw-alias-label-dimmed)}",
			".pm-inputRow{gap:8px;display:flex;align-items:center;flex-wrap:wrap}",
			".pm-sourceList{margin:2px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}",
			".pm-sourceRow{align-items:center;gap:10px;padding:10px 14px;display:flex;transition:background .15s ease}",
			".pm-sourceRow+.pm-sourceRow{border-top:1px solid var(--dsw-alias-border-l1)}",
			".pm-sourceRow:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}",
			".pm-sourceText{flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono);color:var(--dsw-alias-label-secondary)}",
			".pm-sourceBadge{flex:none;font-size:11px;line-height:17px;color:var(--dsw-alias-label-caption);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 7px;font-family:var(--dsw-font-mono)}",

			// 空状态与提示
			".pm-empty{color:var(--dsw-alias-label-caption);margin:16px 0;font-size:13px;text-align:center;padding:28px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}",
			// 待重启区块：提示行与卡片之间保持与已安装区块一致的 18px 纵向间距
			".pm-restartBox{flex-direction:column;gap:18px;display:flex}",
			".pm-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}",
			".pm-hintCode{font-family:var(--dsw-font-mono);color:var(--dsw-alias-label-secondary)}",

			// 加载态与动画
			".pm-spinner{width:16px;height:16px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:pmspin .8s linear infinite;flex:none;display:inline-block;margin:4px 0}",
			".pm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(2px)}",
			".pm-modal{width:100%;max-width:420px;max-height:calc(100vh - 48px);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3);padding:18px 20px;flex-direction:column;gap:12px;display:flex;overflow:hidden}",
			".pm-modalBody{overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:12px}",
			".pm-modalTitle{margin:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}",
			".pm-modalTitle.danger{color:var(--dsw-alias-state-error-primary)}",
			".pm-modalText{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}",
			".pm-modalInput{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;border-radius:7px;padding:8px 12px;width:100%;box-sizing:border-box}",
			".pm-modalRow{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}",
			".pm-reviewRisks{margin:0;padding:0 0 0 18px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;gap:4px;display:flex;flex-direction:column;list-style:disc}",
			".pm-loadingRow{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:10px 0}",
			// 拉取/安装进度条
			".pm-progress{display:flex;flex-direction:column;gap:4px;margin:8px 0 2px}",
			".pm-progressBar{height:5px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}",
			".pm-progressFill{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:width .3s ease}",
			".pm-progressText{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;font-family:var(--dsw-font-mono)}",
			"@keyframes pmspin{to{transform:rotate(360deg)}}",
			"@keyframes pmPulse{0%,100%{opacity:1}50%{opacity:.35}}",
			"@media (max-width:640px){.pm-list{grid-template-columns:1fr}}",

			// 侧边栏 dsh 版本状态灯（品牌名下方）：圆点 + 版本号。
			// 侧边栏根为 flex 列、默认 cross-axis stretch，故本行为全宽；左 padding 对齐 logoRow 的品牌 mark。
			".pm-dshself{display:flex;align-items:center;gap:6px;padding:1px 0 1px 12px;margin:-10px 0 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);cursor:pointer;font-family:var(--dsw-font-mono);user-select:none;transition:color .15s ease}",
			".pm-dshself:hover{color:var(--dsw-alias-label-secondary)}",
			".pm-dshselfDot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-caption);transition:background .2s ease,box-shadow .2s ease}",
			".pm-dshself[data-state=ok] .pm-dshselfDot{background:var(--dsw-alias-state-success-primary)}",
			".pm-dshself[data-state=update] .pm-dshselfDot{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-warn-tertiary)}",
			".pm-dshself[data-state=breaking] .pm-dshselfDot{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-warn-tertiary)}",
			".pm-dshself[data-state=analyzing] .pm-dshselfDot{background:var(--dsw-alias-state-warn-primary);animation:pmPulse 1s ease-in-out infinite}",
			".pm-dshself[data-state=update],.pm-dshself[data-state=breaking]{color:var(--dsw-alias-label-secondary)}",
			".pm-dshselfVersion{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".pm-dshself[data-collapsed=true]{justify-content:center;padding:2px 0}",
			".pm-dshself[data-collapsed=true] .pm-dshselfVersion{display:none}",
		];

		const tagId = "dsh-plugin-market/settings.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css.join("\n");
			document.head.appendChild(tag);
		}

		// ── dictionaries ──────────────────────────────────────────────────────
		const NS = "settings.pluginMarket";
		const zh = {
			tab: "插件市场",
			title: "插件市场",
			intro: "每行一个 GitHub 仓库地址（支持#path: 语法），跟随 GitHub 仓库默认分支最新提交。",
			installed: "已安装插件",
			addSource: "添加",
			sourcePlaceholder: "owner/name 或 https://github.com/owner/name",
			install: "安装",
			installTitle: "安装审查报告",
			updateReviewTitle: "更新审查报告",
			reviewInstalledTitle: "安全审查报告",
			reviewGenerating: "正在生成审查报告…（首次查看会现场审查已安装包）",
			diffTitle: "更新差异",
			diffAdded: "新增",
			diffRemoved: "删除",
			diffChanged: "修改",
			confirmInstall: "确认安装",
			confirmUpdate: "确认更新",
			pendingInstalls: "待安装插件",
			pendingEmpty: "暂无待安装任务",
			restartPending: "待重启",
			restartPendingHint: "重启 dsh web 后加载",
			updateRestartHint: "更新已下载：重启 dsh web 后加载新版本",
			updateFailed: "更新失败：{error}（可能处于不一致状态，重启前不会生效；可重试更新，或在 profile 目录执行 pnpm install --no-frozen-lockfile 后重启）",
			jobPulling: "拉取中",
			pullProgress: "解析 {resolved} 个依赖 · {percent}%",
			jobReviewing: "审查中",
			stageScan: "L0 扫描",
			stageL1: "L1 审查",
			stageAggregate: "聚合终审",
			scanInfo: "{files} 文件 · {signals} 信号",
			jobPending: "待安装",
			jobInstalling: "安装中",
			jobFailed: "失败",
			jobClickToReview: "点击卡片查看报告",
			interrupt: "中断",
			interrupted: "已中断",
			jobHelping: "已交予会话安装",
			helpInstall: "帮我安装",
			helpInstallDone: "已开启安装会话（{sessionId}），报错信息已附上，请到侧边栏会话查看进度",
			helpSessionOpen: "安装会话：{sessionId}",
			helpUpdate: "帮我更新",
			helpUpdateDone: "已开启更新会话（{sessionId}），失败信息已附上，请到侧边栏会话查看进度",
			helpUpdateOpen: "更新会话：{sessionId}",
			uninstall: "卸载",
			uninstallTitle: "确认卸载",
			uninstallConfirm: "确定卸载 {name}？该操作会移除插件包与配置，无法撤销。",
			cancel: "取消",
			save: "保存",
			reviewLabel: "安全审查（分层审查：全量文件特征扫描 + 风险信号定向深挖；报告本地缓存 7 天）",
			reviewModelLabel: "审查模型",
			reviewEffortLabel: "推理程度",
			modelFlash: "Flash",
			modelPro: "Pro",
			effortHigh: "High",
			effortLow: "Low",
			effortOff: "Off",
			reviewOffProgress: "已开启 · 再点 {left} 次可关闭",
			reviewSeverity: "风险级别",
			reviewVerdict: "结论",
			verdictSafe: "安全",
			verdictCaution: "谨慎",
			verdictDanger: "危险",
			sevLow: "低",
			sevMedium: "中",
			sevHigh: "高",
			reviewCached: "（复用本地缓存报告）",
			reviewScanned: "扫描范围",
			dshVersionNote: "基于 dsh {bestFit} 版本开发，其它版本可能不兼容。",
			cleanupCache: "清理缓存",
			cleanupDone: "已清理：{staging} 个隔离残留、{reviews} 份过期审查报告",
			reviewUnavailable: "审查未能完成（审查通道不可用）",
			reviewUnavailableDetail: "LLM 审查通道未产出报告（可能是模型调用失败或返回内容无法解析）。可确认安装或中断。",
			ok: "知道了",
			checkUpdate: "检查更新",
			update: "更新",
			localUpdateHint: "本地安装（link/file）插件：请在源码目录 git pull 拉取更新后重启 dsh web 生效（插件市场只能更新 git 通道安装的插件）",
			on: "启用",
			off: "停用",
			toggleOn: "已启用",
			toggleOff: "已停用",
			toggleNeedsRestart: "补丁已写入，但运行中的 dsh web 未应用该变更——需重启 dsh web 后生效",
			gitUpToDate: "git 已是最新（远端 HEAD 与本地一致）",
			gitHasUpdate: "git 有更新：远端 HEAD {head}…",
			gitAdopt: "未从 git 安装（无锁定 commit）：点「更新」将转为 git 通道安装远端最新版（HEAD {head}…）",
			gitUnknown: "git 无法对比（本地非 git 安装，无锁定 commit）",
			unknown: "未知",
			loading: "读取中…",
			empty: "暂无已安装的第三方插件（dsh 自带插件跟随 dsh 更新，不在此展示）。",
			onlyUser: "仅展示用户安装的插件；dsh 自带插件跟随 dsh 更新，不在此列出。",
			enabled: "已启用",
			disabled: "已停用",
			noSources: "还没有 GitHub 源，添加一个仓库地址开始。",
			version: "版本",
			repo: "仓库",
			localPath: "本地路径",
			updateTitle: "更新插件",
			updateProgress: "正在安装更新…（使用检查更新时已审查的新版本，从隔离环境直接安装，可能需要一两分钟，请勿关闭页面）",
			gitNoRepo: "无远端仓库来源，无法检查更新（仅展示安装时的来源仓库或本地路径）",
			checkGit: "对比远端提交…",
			checkPulling: "拉取新版本：{percent}%",
			checkScanning: "L0 扫描中…",
			checkReviewing: "LLM 审查中…（{files} 文件 · {signals} 信号）",
			checkAggregating: "聚合终审中…",
			phase: "状态",
			removed: "已卸载：{name}",
			removedRestart: "（需重启 dsh web 生效）",
			repoInvalid: "仓库地址格式无效",
			dshUpToDate: "已是最新版本 v{version}",
			dshHasUpdate: "有新版本 v{version}",
			dshBreaking: "有新版本 v{version}，存在破坏性更新",
			dshUnknown: "无法检查更新",
			dshAnalyzing: "正在分析新版本…",
			dshAnalyzeFailed: "分析失败：{error}",
			dshChecking: "检查更新中…",
			dshHasUpdateShort: "有新版本",
			dshBreakingShort: "破坏性更新",
			dshReportChanges: "变更要点",
			dshReportAffected: "可能受影响的插件",
			dshReportDetails: "详情",
			dshReportVersions: "版本变更明细（当前 → 最新，共 {count} 个版本，不跳版本）",
			dshReportVersionBreaking: "破坏性变更",
			dshReportVersionMissing: "（该版本变更未能分析）",
			dshReportVersionEmpty: "（该版本无变更说明）",
		};
		const en = {
			tab: "Plugin Market",
			title: "Plugin Market",
			intro: "One GitHub repo per line (supports #path: syntax); tracks the repo's default branch HEAD.",
			installed: "Installed plugins",
			addSource: "Add",
			sourcePlaceholder: "owner/name or https://github.com/owner/name",
			install: "Install",
			installTitle: "Install review report",
			updateReviewTitle: "Update review report",
			reviewInstalledTitle: "Security review report",
			reviewGenerating: "Generating review report… (first view reviews the installed package)",
			diffTitle: "Update diff",
			diffAdded: "Added",
			diffRemoved: "Removed",
			diffChanged: "Changed",
			confirmInstall: "Install",
			confirmUpdate: "Update",
			pendingInstalls: "Pending installs",
			pendingEmpty: "No pending installs",
			jobPulling: "Pulling",
			pullProgress: "resolving {resolved} deps · {percent}%",
			jobReviewing: "Reviewing",
			stageScan: "L0 scan",
			stageL1: "L1 review",
			stageAggregate: "Aggregate",
			scanInfo: "{files} files · {signals} signals",
			jobPending: "Pending",
			jobInstalling: "Installing",
			jobFailed: "Failed",
			jobClickToReview: "Click card to view report",
			interrupt: "Interrupt",
			interrupted: "Interrupted",
			jobHelping: "Handed to session",
			helpInstall: "Help me install",
			helpInstallDone: "Help session opened ({sessionId}) — error attached, see the sidebar session",
			helpSessionOpen: "Help session: {sessionId}",
			helpUpdate: "Help me update",
			helpUpdateDone: "Update help session opened ({sessionId}) — error attached, see the sidebar session",
			helpUpdateOpen: "Update session: {sessionId}",
			uninstall: "Uninstall",
			uninstallTitle: "Confirm uninstall",
			uninstallConfirm: "Uninstall {name}? This removes the package and its config. This cannot be undone.",
			cancel: "Cancel",
			save: "Save",
			reviewLabel: "Security review (layered: full-file risk scan + targeted deep-dive on signals; reports cached locally for 7 days)",
			reviewModelLabel: "Review model",
			reviewEffortLabel: "Reasoning",
			modelFlash: "Flash",
			modelPro: "Pro",
			effortHigh: "High",
			effortLow: "Low",
			effortOff: "Off",
			reviewOffProgress: "On · {left} more clicks to disable",
			reviewSeverity: "Severity",
			reviewVerdict: "Verdict",
			verdictSafe: "Safe",
			verdictCaution: "Caution",
			verdictDanger: "Danger",
			sevLow: "Low",
			sevMedium: "Medium",
			sevHigh: "High",
			reviewCached: "(reusing cached report)",
			reviewScanned: "Scanned",
			dshVersionNote: "Developed against dsh {bestFit}; other versions may be incompatible.",
			cleanupCache: "Clean cache",
			cleanupDone: "Cleaned: {staging} staging residue, {reviews} stale review reports",
			reviewUnavailable: "Review unavailable (review channel down)",
			reviewUnavailableDetail: "The LLM review channel produced no report (model call failed or the reply could not be parsed). You may confirm the install or interrupt.",
			ok: "OK",
			checkUpdate: "Check update",
			update: "Update",
			localUpdateHint: "Locally linked (link/file) plugin: run git pull in the source directory and restart dsh web (the market can only update git-installed plugins)",
			on: "Enable",
			off: "Disable",
			toggleOn: "Enabled",
			toggleOff: "Disabled",
			toggleNeedsRestart: "Patch written, but the running dsh web did not apply it — restart dsh web for it to take effect",
			gitUpToDate: "git up to date (remote HEAD matches local lock)",
			gitHasUpdate: "git update available: remote HEAD {head}…",
			gitAdopt: "Not installed from git (no locked commit): Update will install the latest remote HEAD {head}… via the git channel",
			gitUnknown: "git check unavailable (not installed from git, no locked commit)",
			unknown: "Unknown",
			loading: "Loading…",
			empty: "No user-installed third-party plugins yet (dsh built-ins follow dsh updates and are hidden here).",
			onlyUser: "Only user-installed plugins are shown; dsh built-ins follow dsh updates and are not listed.",
			restartPending: "Restart pending",
			restartPendingHint: "Loads after restarting dsh web",
			updateRestartHint: "Update downloaded — restart dsh web to load the new version",
			updateFailed: "Update failed: {error} (state may be inconsistent and won't take effect until restart; retry the update, or run pnpm install --no-frozen-lockfile in the profile directory and restart)",
			enabled: "Enabled",
			disabled: "Disabled",
			noSources: "No GitHub sources yet. Add a repo to start.",
			version: "Version",
			repo: "Repo",
			localPath: "Local path",
			updateTitle: "Updating plugin",
			updateProgress: "Installing update… (installing the already-reviewed new version from the staged environment; may take a minute or two, keep this page open)",
			gitNoRepo: "No remote repo source; update check unavailable (only the install-source repo or local path is shown)",
			checkGit: "Comparing remote commit…",
			checkPulling: "Pulling new version: {percent}%",
			checkScanning: "L0 scanning…",
			checkReviewing: "LLM reviewing… ({files} files · {signals} signals)",
			checkAggregating: "Aggregating…",
			phase: "State",
			removed: "Removed: {name}",
			removedRestart: " (restart dsh web to apply)",
			repoInvalid: "Invalid repo address",
			dshUpToDate: "Up to date: v{version}",
			dshHasUpdate: "New version available: v{version}",
			dshBreaking: "New version v{version} — breaking changes detected",
			dshUnknown: "Unable to check for updates",
			dshAnalyzing: "Analyzing the new version…",
			dshAnalyzeFailed: "Analysis failed: {error}",
			dshChecking: "Checking for updates…",
			dshHasUpdateShort: "update available",
			dshBreakingShort: "breaking update",
			dshReportChanges: "Changes",
			dshReportAffected: "Possibly affected plugins",
			dshReportDetails: "Details",
			dshReportVersions: "Version-by-version changes (current → latest, {count} versions, no version skipped)",
			dshReportVersionBreaking: "breaking change",
			dshReportVersionMissing: "(changes for this version could not be analyzed)",
			dshReportVersionEmpty: "(no change notes for this version)",
		};

		// ── helpers ──────────────────────────────────────────────────────────
		function tpl(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (_, key) => (params[key] !== undefined ? String(params[key]) : ""));
		}
		function moduleShortName(moduleName) {
			return (moduleName.startsWith("@") ? moduleName.slice(moduleName.indexOf("/") + 1) : moduleName)
				.replace(/^cordis:/, "").replace(/^cordis-plugin-/, "").replace(/^dsh-(?:host-|client-)?/, "");
		}
		function phaseLabel(phase) {
			if (phase === null) return "—";
			return { pending: "pending", loading: "loading", active: "active", failed: "failed", unloading: "unloading" }[phase] ?? phase;
		}
		async function call(path, body) {
			const response = await fetch(path, body === undefined
				? {}
				: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			let data = null;
			try {
				data = await response.json();
			} catch {}
			if (!response.ok || (data !== null && data.ok === false)) {
				throw new Error(data !== null && typeof data.error === "string" ? data.error : "HTTP " + response.status);
			}
			return data;
		}
		function cleanRepo(value) {
			return String(value ?? "").trim();
		}

		// ── main tab component ───────────────────────────────────────────────
		function PluginMarketTab({ t, sessions }) {
			const [state, setState] = useState({ status: "loading" });
			// 忙状态按操作键记录（而非单一全局值）：不同插件的检查更新/更新/开关等操作互不阻塞，
			// 支持并发检查；同一插件的 check/update 等键互斥，避免同一对象上的并行操作
			const [busy, setBusy] = useState({});
			const busyNow = (key) => busy[key] === true;
			const enterBusy = (key) => setBusy((prev) => ({ ...prev, [key]: true }));
			const leaveBusy = (key) => setBusy((prev) => { if (prev[key] !== true) return prev; const next = { ...prev }; delete next[key]; return next; });
			const [message, setMessage] = useState(null);
			const [messageOk, setMessageOk] = useState(false);
			const [sources, setSources] = useState([]);
			const [draft, setDraft] = useState("");
			// 安全审查开关(默认开启,localStorage 持久化)
			const [review, setReview] = useState(() => { try { return localStorage.getItem("pm-review") !== "0"; } catch { return true; } });
			// 审查模型/推理程度（localStorage 持久化；默认 Pro High——推理档位 High/Low/Off 与模型一致）
			const VALID_EFFORTS = ["high", "low", "off"];
			const [route, setRoute] = useState(() => {
				try {
					const raw = localStorage.getItem("pm-review-effort") || "";
					// 旧值迁移：max → high、none → off；无效值回落 high
					const effort = raw === "max" ? "high" : raw === "none" ? "off" : (VALID_EFFORTS.includes(raw) ? raw : "high");
					return {
						model: localStorage.getItem("pm-review-model") || "deepseek-v4-pro",
						effort,
					};
				} catch { return { model: "deepseek-v4-pro", effort: "high" }; }
			});
			const setRouteModel = (model) => { setRoute((prev) => ({ ...prev, model })); try { localStorage.setItem("pm-review-model", model); } catch {} };
			const setRouteEffort = (effort) => { setRoute((prev) => ({ ...prev, effort })); try { localStorage.setItem("pm-review-effort", effort); } catch {} };
			// 模态框:null 或 { type: "confirm"|"repo", entry, value? }
			const [modal, setModal] = useState(null);
			const [updateChecks, setUpdateChecks] = useState({});
			// 弹窗代次：进行中弹窗（审查生成/更新安装）被手动关闭时 +1，
			// 异步 then 里对比代次，防止用户关闭后又被结果"复活"弹窗
			const modalGen = useRef(0);
			const closeModal = () => { modalGen.current += 1; setModal(null); };

			const refresh = () => {
				call("/plugin-market/state")
					.then((data) => setState({ status: "ready", data }))
					.catch((error) => setState({ status: "error", error }));
			};
			useEffect(() => { refresh(); }, []);
			// 待安装任务轮询：有任务时每 1 秒实时刷新（审查耗时/阶段实时跳动）
			let lastJobsKey = null;
			const stageLabel = (stage) => stage === "scan" ? t("stageScan") : stage === "l1" ? t("stageL1") : stage === "aggregate" ? t("stageAggregate") : stage;
			// 检查更新/审查实时进度文案（服务端 checks 结构化进度 → 本地化显示）
			const checkStageText = (prog) => {
				if (!prog) return null;
				if (prog.stage === "git") return t("checkGit");
				if (prog.stage === "pulling") return tpl(t("checkPulling"), { percent: prog.percent != null ? String(prog.percent) : "…" });
				if (prog.stage === "scanning") return t("checkScanning");
				if (prog.stage === "reviewing") return tpl(t("checkReviewing"), { files: String(prog.files ?? "?"), signals: String(prog.signals ?? "?") });
				if (prog.stage === "aggregating") return t("checkAggregating");
				return null;
			};
			useEffect(() => {
				const timer = setInterval(() => {
					fetch("/plugin-market/state").then((r) => r.json()).then((d) => {
						if (!d || !Array.isArray(d.jobs)) return;
						// 有任务或有实时进度 → 每次刷新；否则只在有变化时更新（清空残留卡片）
						const checksActive = d.checks && Object.keys(d.checks).length > 0;
						const key = d.jobs.map((j) => j.jobId + ":" + j.status).join(",") + "|" + JSON.stringify(d.checks ?? {});
						if (d.jobs.length > 0 || checksActive || key !== lastJobsKey) { lastJobsKey = key; setState({ status: "ready", data: d }); }
					}).catch(() => {});
				}, 1000);
				return () => { lastJobsKey = null; clearInterval(timer); };
			}, []);

			const flash = (text, ok) => {
				setMessage(text);
				setMessageOk(ok === true);
				// 报错给足查看时间（20s），成功提示保持 5s 不遮挡界面
				setTimeout(() => setMessage(null), ok === true ? 5000 : 20000);
			};

			const doToggle = (entry, enabled) => {
				const key = "toggle:" + entry.entryId;
				enterBusy(key);
				call("/plugin-market/toggle", { entryId: entry.entryId, enabled })
					.then((data) => {
						refresh();
						if (data.needsRestart === true) flash(t("toggleNeedsRestart"), false);
						else flash(enabled ? t("toggleOn") : t("toggleOff"), true);
					})
					.catch((error) => flash(error.message, false))
					.finally(() => leaveBusy(key));
			};

			const doCheckUpdate = (entry) => {
				const key = "check:" + entry.entryId;
				enterBusy(key);
				call("/plugin-market/check-update", { packageName: entry.moduleName, repository: entry.repository ?? "", review, model: route.model, effort: route.effort })
					.then((data) => {
						setUpdateChecks((prev) => ({ ...prev, [entry.entryId]: data }));
						// 审查通过后服务端保留隔离目录（updateJobId）：确认更新时直接从该环境安装
						if (data.review && data.review.verdict) setModal({ type: "review", report: data.review, title: "更新审查报告", entry, updateJobId: data.updateJobId ?? "" });
					})
					.catch((error) => flash(error.message, false))
					.finally(() => leaveBusy(key));
			};

			// 安全审查开关：开启 1 次点击；关闭需连点 5 次（点击整个文案计数）；每次切换后 1 秒保护期，防误触又开启
			const REVIEW_OFF_CLICKS = 5;
			const reviewLockAt = useRef(0);
			const reviewOffClicks = useRef(0);
			const clickReview = (event) => {
				if (Date.now() < reviewLockAt.current) return; // 1 秒保护期
				// label 点击会被浏览器转发到内部 checkbox 再冒泡回来（导致一次物理点击计两次）→ 忽略转发事件
				if (event && event.target && event.target.tagName === "INPUT") return;
				if (!review) {
					// 开启：1 次点击
					setReview(true);
					try { localStorage.setItem("pm-review", "1"); } catch {}
					reviewLockAt.current = Date.now() + 1000;
					reviewOffClicks.current = 0;
					return;
				}
				// 关闭：连点 5 次
				reviewOffClicks.current += 1;
				if (reviewOffClicks.current >= REVIEW_OFF_CLICKS) {
					setReview(false);
					try { localStorage.setItem("pm-review", "0"); } catch {}
					reviewLockAt.current = Date.now() + 1000;
					reviewOffClicks.current = 0;
				}
			};

			const confirmUninstall = (entry) => setModal({ type: "confirm", entry });

			const doUninstall = () => {
				const entry = modal.entry;
				setModal(null);
				const key = "uninstall:" + entry.entryId;
				enterBusy(key);
				call("/plugin-market/uninstall", { entryId: entry.entryId })
					.then((data) => { refresh(); flash(tpl(t("removed"), { name: data.packageName ?? entry.moduleName }) + (data.restart ? t("removedRestart") : "") + (data.uninstallError ? "：" + data.uninstallError : ""), true); })
					.catch((error) => flash(error.message, false))
					.finally(() => leaveBusy(key));
			};

			const persistSources = (next) => {
				call("/plugin-market/sources", { sources: next })
					.then(() => { setSources(next); })
					.catch((error) => flash(error.message, false));
			};

			const addSource = () => {
				const value = cleanRepo(draft);
				if (value === "") return;
				if (!/^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|https:\/\/github\.com\/[^/]+\/[^/?#]+)(?:#path:[^\s#]+)?$/.test(value)) {
					flash(t("repoInvalid"), false);
					return;
				}
				if (!sources.includes(value)) persistSources([...sources, value]);
				setDraft("");
			};

			const removeSource = (value) => persistSources(sources.filter((item) => item !== value));

			const finishInstall = (data) => {
				refresh();
				flash("git 通道安装完成" + (data.restart ? "（需重启 dsh web）" : ""), true);
			};
			const doInstall = (repo) => {
				const key = "install:" + repo;
				enterBusy(key);
				call("/plugin-market/install", { repo, review, model: route.model, effort: route.effort })
					.then((data) => {
						if (data.pending === true && data.jobId) {
							// 阶段 1 完成：有审查报告 → 弹窗等用户确认；
							// 勾选了审查但无报告（审查通道不可用）→ 也弹窗提示（caution），不静默自动安装；
							// 未勾选审查 → 直接确认安装
							if (data.review && data.review.verdict) {
								setModal({ type: "review", report: data.review, title: t("installTitle"), pending: data });
							} else if (!review) {
								return call("/plugin-market/install/confirm", { jobId: data.jobId }).then(finishInstall);
							} else {
								setModal({ type: "review", report: { summary: t("reviewUnavailable"), risks: [], severity: "low", verdict: "caution", details: t("reviewUnavailableDetail") }, title: t("installTitle"), pending: data });
							}
						} else {
							finishInstall(data);
						}
					})
					.catch((error) => { if (!String(error.message ?? "").includes("已中断")) flash(error.message, false); })
					.finally(() => leaveBusy(key));
			};
			const doConfirmInstall = () => {
				const pending = modal.pending;
				setModal(null);
				const key = "install:" + (pending.packageName ?? "");
				enterBusy(key);
				call("/plugin-market/install/confirm", { jobId: pending.jobId })
					.then(finishInstall)
					.catch((error) => flash(error.message, false))
					.finally(() => leaveBusy(key));
			};
			const doInterrupt = (jobId, event) => {
				if (event) event.stopPropagation();
				const key = "interrupt:" + jobId;
				enterBusy(key);
				call("/plugin-market/install/interrupt", { jobId })
					.then(() => { refresh(); flash(t("interrupted"), true); })
					.catch((error) => flash(error.message, false))
					.finally(() => leaveBusy(key));
			};
			const readCurrentSessionId = () => {
				try {
					const list = sessions && sessions.list;
					const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
					return snap && typeof snap.current === "string" ? snap.current : "";
				} catch { return ""; }
			};
			// 帮我安装：失败任务 → 开启可见 harness 会话并附上报错，由会话诊断并完成安装
			const doHelpInstall = (job, event) => {
				if (event) event.stopPropagation();
				const key = "help:" + job.jobId;
				enterBusy(key);
				call("/plugin-market/install/help", { jobId: job.jobId, sessionId: readCurrentSessionId() })
					.then((data) => {
						refresh();
						flash(tpl(t("helpInstallDone"), { sessionId: data.sessionId ?? "" }), true);
						if (data && typeof data.sessionId === "string" && data.sessionId !== ""
							&& sessions && typeof sessions.refresh === "function" && typeof sessions.open === "function") {
							sessions.refresh().then(() => sessions.open(data.sessionId)).catch(() => {});
						}
					})
					.catch((error) => flash(error.message, false))
					.finally(() => leaveBusy(key));
			};
			// 帮我更新：更新失败的插件 → 开启可见 harness 会话并附上失败信息，由会话诊断并完成更新
			const doHelpUpdate = (entry) => {
				const key = "help-update:" + entry.entryId;
				enterBusy(key);
				call("/plugin-market/update/help", { entryId: entry.entryId, sessionId: readCurrentSessionId() })
					.then((data) => {
						refresh();
						flash(tpl(t("helpUpdateDone"), { sessionId: data.sessionId ?? "" }), true);
						if (data && typeof data.sessionId === "string" && data.sessionId !== ""
							&& sessions && typeof sessions.refresh === "function" && typeof sessions.open === "function") {
							sessions.refresh().then(() => sessions.open(data.sessionId)).catch(() => {});
						}
					})
					.catch((error) => flash(error.message, false))
					.finally(() => leaveBusy(key));
			};
			const reviewingRef = useRef(new Set());
			const doViewReview = (entry) => {
				// 同一插件上有进行中的检查更新/更新任务时不另起审查（避免同一插件并行跑两路审查）；
				// 其它插件的进行中任务不阻塞本卡片
				if (busyNow("check:" + entry.entryId) || busyNow("update:" + entry.entryId)) return;
				if (reviewingRef.current.has(entry.entryId)) return; // 该插件审查生成中，忽略重复点击（卡片 meta 区显示进度）
				reviewingRef.current.add(entry.entryId);
				const gen = ++modalGen.current;
				// 不弹「生成中」弹窗：卡片 meta 区实时显示审查进度（L0 扫描 → LLM 审查 → 聚合终审），完成后弹报告
				call("/plugin-market/review", { entryId: entry.entryId, model: route.model, effort: route.effort })
					.then((data) => { if (modalGen.current === gen) setModal({ type: "review", report: data.report, title: t("reviewInstalledTitle") }); })
					.catch((error) => { if (modalGen.current === gen) setModal(null); flash(error.message, false); })
					.finally(() => reviewingRef.current.delete(entry.entryId));
			};
			const doCleanup = () => {
				enterBusy("cleanup");
				call("/plugin-market/cleanup")
					.then((data) => { refresh(); flash(tpl(t("cleanupDone"), { staging: data.removedStaging ?? 0, reviews: data.removedReviews ?? 0 }), true); })
					.catch((error) => flash(error.message, false))
					.finally(() => leaveBusy("cleanup"));
			};
			const clickJob = (job) => {
				// 待安装状态点击卡片可再次唤起审查报告
				if (job.status === "pending" && job.review && job.review.verdict) {
					setModal({ type: "review", report: job.review, title: t("installTitle"), pending: job });
				}
			};
			const doConfirmUpdate = () => {
				const entry = modal.entry;
				const updateJobId = modal.updateJobId ?? "";
				// 直接从检查更新时已审查的隔离环境安装（不重新拉取/审查）：先打开进度弹窗，让用户知道正在安装；
				// 更新是长请求：弹窗带「取消」——关闭后请求继续在后台完成，结果只走消息提示，不再弹回报告
				const gen = ++modalGen.current;
				setModal({ type: "update-loading", entry, onCancel: closeModal });
				const key = "update:" + entry.entryId;
				enterBusy(key);
				call("/plugin-market/update", { entryId: entry.entryId, repository: entry.repository ?? "", updateJobId, model: route.model, effort: route.effort })
					.then((data) => {
						refresh();
						setUpdateChecks((prev) => { const next = { ...prev }; delete next[entry.entryId]; return next; });
						flash("git 通道更新完成" + (data.restart ? "（需重启 dsh web）" : ""), true);
						// 更新也做安全审查：报告附更新差异（相对已装代码改了什么）
						if (modalGen.current !== gen) return; // 用户已关闭进度弹窗：不再弹出报告
						if (data.review && data.review.verdict) setModal({ type: "review", report: data.review, title: t("updateReviewTitle") });
						else setModal(null);
					})
					.catch((error) => { if (modalGen.current === gen) setModal(null); refresh(); flash(error.message, false); })
					.finally(() => leaveBusy(key));
			};
			// 检查更新后出现「有更新」时的更新入口：
			//   审查开启且已生成隔离任务（updateJobId）→ 打开审查报告弹窗，确认后直接安装；
			//   审查关闭/无任务 → 直接 git 通道更新（不重新拉取审查），避免「检查到更新却无处更新」
			const doUpdateFromCheck = (entry, check) => {
				if (check && check.updateJobId) {
					setModal({ type: "review", report: check.review, title: t("updateReviewTitle"), entry, updateJobId: check.updateJobId });
					return;
				}
				doDirectUpdate(entry);
			};
			const doDirectUpdate = (entry) => {
				const gen = ++modalGen.current;
				setModal({ type: "update-loading", entry, onCancel: closeModal });
				const key = "update:" + entry.entryId;
				enterBusy(key);
				call("/plugin-market/update", { entryId: entry.entryId, repository: entry.repository ?? "", review: false })
					.then((data) => {
						refresh();
						setUpdateChecks((prev) => { const next = { ...prev }; delete next[entry.entryId]; return next; });
						flash("git 通道更新完成" + (data.restart ? "（需重启 dsh web）" : ""), true);
						if (modalGen.current !== gen) return; // 用户已关闭进度弹窗：不再弹出报告
						if (data.review && data.review.verdict) setModal({ type: "review", report: data.review, title: t("updateReviewTitle") });
						else setModal(null);
					})
					.catch((error) => { if (modalGen.current === gen) setModal(null); refresh(); flash(error.message, false); })
					.finally(() => leaveBusy(key));
			};

			if (state.status === "loading") {
				return h("div", { className: "pm-section" },
					h("h3", null, t("title")),
					h("div", { className: "pm-loadingRow" },
						h("span", { className: "pm-spinner" }),
						h("span", null, t("loading"))
					)
				);
			}
			if (state.status === "error") {
				return h("div", { className: "pm-section" },
					h("h3", null, t("title")),
					h("p", { className: "pm-message", "data-error": "true" }, state.error.message)
				);
			}

			const renderModal = () => {
				if (modal.type === "confirm") {
					return h("div", { className: "pm-overlay", onClick: () => setModal(null) },
						h("div", { className: "pm-modal", onClick: (e) => e.stopPropagation() },
							h("p", { className: "pm-modalTitle danger" }, t("uninstallTitle")),
							h("p", { className: "pm-modalText" }, tpl(t("uninstallConfirm"), { name: modal.entry.moduleName })),
							h("div", { className: "pm-modalRow" },
								h("button", { className: "pm-btn", onClick: () => setModal(null) }, t("cancel")),
								h("button", { className: "pm-btn danger", onClick: doUninstall }, t("uninstall"))
							)
						)
					);
				}
				if (modal.type === "update-loading") {
					// 更新是数分钟的长请求：弹窗可关闭（请求在后台继续完成，结果只走消息提示，不再弹回报告）
					return h("div", { className: "pm-overlay", onClick: modal.onCancel ?? closeModal },
						h("div", { className: "pm-modal", onClick: (e) => e.stopPropagation() },
							h("p", { className: "pm-modalTitle" }, t("updateTitle")),
							h("div", { className: "pm-loadingRow" },
								h("span", { className: "pm-spinner" }),
								h("span", null, t("updateProgress"))
							),
							h("div", { className: "pm-modalRow" },
								h("button", { className: "pm-btn", onClick: modal.onCancel ?? closeModal }, t("cancel"))
							)
						)
					);
				}
				if (modal.type === "review") {
					const rep = modal.report;
					const sev = rep.severity ?? "low";
					const vd = rep.verdict ?? "caution";
					const sevColor = sev === "high" ? "var(--dsw-alias-state-error-primary)" : (sev === "medium" ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-success-primary)");
					const vdLabel = vd === "danger" ? t("verdictDanger") : (vd === "caution" ? t("verdictCaution") : t("verdictSafe"));
					const vdColor = vd === "danger" ? "var(--dsw-alias-state-error-primary)" : (vd === "caution" ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-success-primary)");
					return h("div", { className: "pm-overlay", onClick: () => setModal(null) },
						h("div", { className: "pm-modal", onClick: (e) => e.stopPropagation(), style: { maxWidth: 480 } },
							h("p", { className: "pm-modalTitle" }, modal.title),
							h("div", { className: "pm-modalBody" },
								h("p", { className: "pm-modalText" }, rep.summary || ""),
								rep.risks && rep.risks.length > 0 ? h("ul", { className: "pm-reviewRisks" }, rep.risks.map((r, i) => h("li", { key: i }, r))) : null,
								h("p", { className: "pm-modalText", style: { color: sevColor } }, t("reviewSeverity") + ": " + (sev === "high" ? t("sevHigh") : sev === "medium" ? t("sevMedium") : t("sevLow"))),
								h("p", { className: "pm-modalText", style: { color: vdColor, fontWeight: 600 } }, t("reviewVerdict") + ": " + vdLabel),
								rep.details ? h("p", { className: "pm-modalText" }, rep.details) : null,
								rep.cached ? h("p", { className: "pm-hint" }, t("reviewCached")) : null,
								rep.scanned ? h("p", { className: "pm-hint" }, t("reviewScanned") + ": " + rep.scanned.files + " files · " + rep.scanned.sizeKB + " KB · " + rep.scanned.signals + " signals" + (rep.method ? " · " + rep.method : "") + (rep.channel ? " · " + rep.channel : "")) : null,
								rep.diff && (rep.diff.added.length + rep.diff.removed.length + rep.diff.changed.length) > 0 ? h("ul", { className: "pm-reviewRisks" },
									rep.diff.added.slice(0, 15).map((x) => h("li", { key: "a" + x }, t("diffAdded") + ": " + x)),
									rep.diff.removed.slice(0, 15).map((x) => h("li", { key: "r" + x }, t("diffRemoved") + ": " + x)),
									rep.diff.changed.slice(0, 15).map((x) => h("li", { key: "c" + x }, t("diffChanged") + ": " + x))
								) : null
							),
							h("div", { className: "pm-modalRow" },
								modal.pending
									? [
										h("button", { className: "pm-btn", onClick: () => setModal(null) }, t("cancel")),
										h("button", { className: "pm-btn primary", onClick: () => doConfirmInstall() }, t("confirmInstall"))
									]
									: modal.entry
										? [
											h("button", { className: "pm-btn", onClick: () => setModal(null) }, t("cancel")),
											h("button", { className: "pm-btn primary", onClick: () => doConfirmUpdate() }, t("confirmUpdate"))
										]
										: h("button", { className: "pm-btn primary", onClick: () => setModal(null) }, t("ok"))
							)
						)
					);
				}
				// 编辑仓库功能已移除：其余未知弹窗类型不渲染
				return null;
			};

			const entries = state.data.entries ?? [];
			const jobs = state.data.jobs ?? [];
			// 只展示用户安装的插件；dsh 自带的官方 bundle 与基础设施跟随 dsh 更新，不在此展示
			const entriesVisible = entries.filter((entry) => entry.userInstalled === true);
			// 待重启：更新已下载（kind:'update'，条目已在运行树 → 在已安装卡片上标「待重启」标签）；
			// bundle/insert 待加载项没有对应卡片，仍需单独区域展示
			const pendingRestart = state.data.pendingRestart ?? [];
			const pendingUpdateNames = new Set(pendingRestart.filter((p) => p.kind === "update").map((p) => p.moduleName));
			const pendingOther = pendingRestart.filter((p) => p.kind !== "update");

			return h("div", { className: "pm-section" },
				h("h3", null, t("title")),
				(state.data.dshBestFit ? h("p", { className: "pm-hint" }, tpl(t("dshVersionNote"), { bestFit: state.data.dshBestFit })) : null),
				h("p", { className: "pm-intro" }, t("intro")),
				h("label", { className: "pm-reviewRow", style: { marginTop: 10, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, onClick: clickReview, title: review ? tpl(t("reviewOffProgress"), { left: String(Math.max(1, REVIEW_OFF_CLICKS - reviewOffClicks.current)) }) : undefined },
					h("input", { type: "checkbox", checked: review, readOnly: true, tabIndex: -1, style: { accentColor: "var(--dsw-alias-state-business-primary)", pointerEvents: "none" } }),
					h("span", { className: "pm-hint" }, t("reviewLabel")),
					review && reviewOffClicks.current > 0 ? h("span", { className: "pm-hint", style: { color: "var(--dsw-alias-state-warning, #e6a23c)" } }, tpl(t("reviewOffProgress"), { left: String(REVIEW_OFF_CLICKS - reviewOffClicks.current) })) : null
				),
				review ? h("div", { className: "pm-inputRow", style: { marginTop: 6 } },
					h("span", { className: "pm-hint" }, t("reviewModelLabel") + ":"),
					h("select", { className: "pm-select", value: route.model, onChange: (event) => setRouteModel(event.target.value) },
						h("option", { value: "deepseek-v4-flash" }, t("modelFlash")),
						h("option", { value: "deepseek-v4-pro" }, t("modelPro"))
					),
					h("span", { className: "pm-hint" }, t("reviewEffortLabel") + ":"),
					h("select", { className: "pm-select", value: route.effort, onChange: (event) => setRouteEffort(event.target.value) },
						h("option", { value: "high" }, t("effortHigh")),
						h("option", { value: "low" }, t("effortLow")),
						h("option", { value: "off" }, t("effortOff"))
					)
				) : null,
				h("div", { className: "pm-inputRow", style: { marginTop: 6 } },
					h("button", { className: "pm-btn", disabled: busyNow("cleanup"), onClick: doCleanup }, t("cleanupCache"))
				),
				message === null ? null : h("p", { className: "pm-message", "data-error": messageOk ? undefined : "true", "data-ok": messageOk ? "true" : undefined }, message),

				// GitHub 插件源(插件市场 section 内的子内容, 无独立标题)
				h("div", { className: "pm-inputRow" },
					h("input", {
						className: "pm-input",
						placeholder: t("sourcePlaceholder"),
						value: draft,
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") addSource(); }
					}),
					h("button", { className: "pm-btn primary", onClick: addSource }, t("addSource"))
				),
				sources.length === 0
					? h("p", { className: "pm-empty" }, t("noSources"))
					: h("ul", { className: "pm-sourceList" }, sources.map((repo) => {
						const withPath = repo.includes("#path:");
						// 同仓库已有进行中的安装任务 → 禁用安装按钮（服务端同样拦截）
						const installing = jobs.some((job) => job.repo === repo);
						return h("li", { className: "pm-sourceRow", key: repo },
							h("span", { className: "pm-sourceText" }, repo),
							withPath ? h("span", { className: "pm-sourceBadge" }, "subdir") : null,
							h("button", { className: "pm-btn primary", disabled: busyNow("install:" + repo) || installing, onClick: () => doInstall(repo) }, installing ? t("jobInstalling") : t("install")),
							h("button", { className: "pm-btn danger", onClick: () => removeSource(repo) }, "✕")
						);
					})),

// 待安装插件（进行中的安装任务：拉取中 / 审查中 / 待安装）
				h("h3", null, t("pendingInstalls")),
				jobs.length === 0
					? h("p", { className: "pm-empty" }, t("pendingEmpty"))
					: h("ul", { className: "pm-list" }, jobs.map((job) => {
						// 失败判定（显示报错与失败状态）：显式 failed，或拉取/审查失败（status 仍为 pending 但带 error）
						const jobFailed = job.status !== "helping" && (job.status === "failed" || (job.error != null && job.error !== ""));
						// 可「帮我安装」：仅安装阶段失败（审查选中时指审查结束、点击确认安装之后的失败；拉取/审查失败不提供）
						const jobHelpable = job.status === "failed";
						const statusLabel = job.status === "pulling"
							? (t("jobPulling") + " · " + Math.max(1, Math.round((Date.now() - job.createdAt) / 1000)) + "s")
							: job.status === "reviewing"
								? (t("jobReviewing") + (job.stage ? " · " + stageLabel(job.stage) : "") + " · " + Math.max(1, Math.round((Date.now() - job.createdAt) / 1000)) + "s")
							: job.status === "installing" ? t("jobInstalling")
							: jobFailed ? t("jobFailed")
							: job.status === "helping" ? t("jobHelping")
							: t("jobPending");
						return h("li", { className: "pm-row", key: job.jobId, "data-job": job.status,
							onClick: () => clickJob(job) },
							h("div", { className: "pm-rowTop" },
								h("span", { className: "pm-dot", "data-enabled": job.status === "pending" ? "true" : "false" }),
								h("span", { className: "pm-name" }, job.packageName || job.repo),
								h("span", { className: "pm-tag", "data-enabled": job.status === "pending" ? "true" : "false" }, statusLabel)
							),
							h("div", { className: "pm-meta" },
								h("span", { className: "pm-repo" }, job.repo),
								job.scan ? h("span", { className: "pm-hint" }, tpl(t("scanInfo"), { files: job.scan.files, signals: job.scan.signals })) : null,
								job.review && job.review.verdict ? h("span", { className: "pm-hint" }, t("jobClickToReview")) : null,
								jobFailed && job.error ? h("span", { className: "pm-message", "data-error": "true" }, job.error) : null,
								job.status === "helping" && job.helpSessionId ? h("span", { className: "pm-hint" }, tpl(t("helpSessionOpen"), { sessionId: job.helpSessionId })) : null
							),
							(job.status === "pulling" || job.status === "installing") && job.progress
								? h("div", { className: "pm-progress" },
									h("div", { className: "pm-progressBar" },
										h("div", { className: "pm-progressFill", style: { width: (job.progress.percent ?? 0) + "%" } })
									),
									h("span", { className: "pm-progressText" },
										tpl(t("pullProgress"), { resolved: job.progress.resolved ?? 0, percent: job.progress.percent ?? 0 })
									)
								)
								: null,
							h("div", { className: "pm-btns" },
								jobHelpable
									? h("button", { className: "pm-btn primary", disabled: busyNow("help:" + job.jobId) || busyNow("interrupt:" + job.jobId), onClick: (e) => doHelpInstall(job, e) }, t("helpInstall"))
									: null,
								h("button", { className: "pm-btn danger", disabled: busyNow("interrupt:" + job.jobId) || busyNow("help:" + job.jobId), onClick: (e) => doInterrupt(job.jobId, e) }, t("interrupt"))
							)
						);
					})),

				// 已安装插件
				h("h3", null, t("installed")),
				h("p", { className: "pm-hint" }, t("onlyUser")),
				entriesVisible.length === 0
					? h("p", { className: "pm-empty" }, t("empty"))
					: h("ul", { className: "pm-list" }, entriesVisible.map((entry) => {
						const check = updateChecks[entry.entryId];
						const checkButton = h("button", {
							className: "pm-btn",
							disabled: busyNow("check:" + entry.entryId) || busyNow("update:" + entry.entryId) || entry.localInstalled,
							title: entry.localInstalled ? t("localUpdateHint") : undefined,
							onClick: (e) => { e.stopPropagation(); doCheckUpdate(entry); }
						}, t("checkUpdate"));
						return h("li", { className: "pm-row", key: entry.entryId, "data-enabled": entry.enabled ? "true" : "false",
							onClick: () => doViewReview(entry) },
							h("div", { className: "pm-rowTop" },
								h("span", { className: "pm-dot", "data-enabled": entry.enabled ? "true" : "false" }),
								h("span", { className: "pm-name" }, moduleShortName(entry.moduleName)),
								pendingUpdateNames.has(entry.moduleName)
									? h("span", { className: "pm-tag", "data-pending": "true" }, t("restartPending"))
									: h("span", { className: "pm-tag", "data-enabled": entry.enabled ? "true" : "false" }, entry.enabled ? t("enabled") : t("disabled")),
								entry.protected ? h("span", { className: "pm-tag protected" }, "Protected") : null
							),
							h("div", { className: "pm-meta" },
								h("span", null, t("version") + ": " + (entry.version ?? t("unknown"))),
								h("span", null, t("phase") + ": " + phaseLabel(entry.fiberPhase)),
								// 只展示安装来源：拉取时的远端仓库或本地路径（编辑仓库功能已移除）
								entry.repository ? h("span", { className: "pm-repo" }, t("repo") + ": " + entry.repository) : null,
								entry.localPath ? h("span", { className: "pm-repo pm-repoPath" }, t("localPath") + ": " + entry.localPath) : null,
								pendingUpdateNames.has(entry.moduleName) ? h("span", { className: "pm-hint" }, t("updateRestartHint")) : null,
								state.data.checks && state.data.checks["check:" + entry.moduleName]
									? h("span", { className: "pm-hint", "data-progress": "true" }, checkStageText(state.data.checks["check:" + entry.moduleName]))
									: null,
								state.data.checks && state.data.checks["review:" + entry.entryId]
									? h("span", { className: "pm-hint", "data-progress": "true" }, checkStageText(state.data.checks["review:" + entry.entryId]))
									: null
							),
							check !== undefined && check.git !== null
								? (check.git.fetchError
									? h("p", { className: "pm-message", "data-error": "true" }, check.git.fetchError)
									: check.git.hasUpdate
										? h("div", { className: "pm-updateRow" },
											h("p", { className: "pm-message", "data-error": "true" },
												check.git.unknown
													? tpl(t("gitAdopt"), { head: String(check.git.remoteHead ?? "").slice(0, 7) })
													: tpl(t("gitHasUpdate"), { head: String(check.git.remoteHead ?? "").slice(0, 7) })),
											h("button", { className: "pm-btn primary", disabled: busyNow("update:" + entry.entryId) || busyNow("check:" + entry.entryId), onClick: (e) => { e.stopPropagation(); doUpdateFromCheck(entry, check); } }, t("update")))
										: check.git.unknown
											? h("p", { className: "pm-message" }, t("gitUnknown"))
											: h("p", { className: "pm-message", "data-ok": "true" }, t("gitUpToDate")))
								: check !== undefined && check.git === null
									? h("p", { className: "pm-message" }, t("gitNoRepo"))
									: null,
								state.data.updateFailures && state.data.updateFailures[entry.moduleName]
									? h("div", { className: "pm-updateRow" },
										h("p", { className: "pm-message", "data-error": "true" }, tpl(t("updateFailed"), { error: state.data.updateFailures[entry.moduleName].error ?? "" })),
										h("button", { className: "pm-btn primary", disabled: busyNow("help-update:" + entry.entryId), onClick: (e) => { e.stopPropagation(); doHelpUpdate(entry); } },
											state.data.updateFailures[entry.moduleName].helpSessionId
												? tpl(t("helpUpdateOpen"), { sessionId: state.data.updateFailures[entry.moduleName].helpSessionId })
												: t("helpUpdate"))
									)
									: null,
							h("div", { className: "pm-btns" },
								entry.toggleable
									? h("button", { className: "pm-btn", disabled: busyNow("toggle:" + entry.entryId), onClick: (e) => { e.stopPropagation(); doToggle(entry, !entry.enabled); } },
										entry.enabled ? t("off") : t("on"))
									: null,
								checkButton,
								(entry.extra || entry.userBundle === true) && !entry.localInstalled
									? h("button", { className: "pm-btn danger", disabled: busyNow("uninstall:" + entry.entryId), onClick: (e) => { e.stopPropagation(); confirmUninstall(entry); } }, t("uninstall"))
									: null
							)
						);
					})),
				// 已写入但尚未加载进运行树（bundle 层启动时应用 / insert 热重载未生效）：
				// 这类没有已安装卡片，单独区域展示；更新待重启已并入已安装卡片的「待重启」标签
				pendingOther.length === 0
					? null
					: h("div", { className: "pm-restartBox" },
						h("p", { className: "pm-hint" }, t("restartPendingHint")),
						h("ul", { className: "pm-list" }, pendingOther.map((pending) =>
							h("li", { className: "pm-row", key: pending.moduleName, "data-enabled": "false" },
								h("div", { className: "pm-rowTop" },
									h("span", { className: "pm-dot", "data-enabled": "false" }),
									h("span", { className: "pm-name" }, moduleShortName(pending.moduleName)),
									h("span", { className: "pm-tag", "data-pending": "true" }, t("restartPending"))
								),
								h("div", { className: "pm-meta" },
									h("span", { className: "pm-repo" }, pending.channel === "git" ? String(pending.spec ?? "git").replace(/^github:/u, "") : (pending.channel + (pending.spec ? " · " + pending.spec : "")))
								)
							)
						))
					),

				modal !== null ? renderModal() : null
			);
		}

		// ── plugin entry ──────────────────────────────────────────────────────
		const inject = ["slots", "locale", "sessions"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-market: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "plugin-market",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({ sessions: ctx.sessions }),
			}, PluginMarketTab));

			// ── 侧边栏 dsh 版本状态灯（品牌名下方，DOM 注入） ────────────────
			ctx.effect(() => {
				if (typeof document === "undefined") return;
				// 折叠开关按钮（唯一且中英双语文案都匹配），其父元素即 logoRow；
				// 状态灯注入 logoRow 之后。dsh 升级若改文案，仅需在此处更新选择器。
				const TOGGLE_SEL = 'button[aria-label="收起侧边栏"], button[aria-label="打开侧边栏"], button[aria-label="Collapse sidebar"], button[aria-label="Open sidebar"]';
				const NORMAL_POLL_MS = 60000;
				const FAST_POLL_MS = 1000;

				let statusEl = null;
				let observer = null;
				let attrObserver = null;
				let pollTimer = null;
				let scanTimer = null;
				let fast = false;
				let analyzeBusy = false;

				const paint = (d) => {
					if (!statusEl) return;
					let state;
					let text = "";
					if (!d || d.ok === false) {
						state = "unknown"; text = d && d.installed ? "v" + d.installed : "";
					} else if (d.status === "analyzing") {
						state = "analyzing"; text = (d.installed ? "v" + d.installed + " · " : "") + t("dshAnalyzing");
					} else if (d.hasUpdate === true && d.verdict === "breaking") {
						// 简约拼接：版本号 + 状态标记（判定详情点击弹窗查看）
						state = "breaking"; text = (d.installed ? "v" + d.installed + " · " : "") + t("dshBreakingShort");
					} else if (d.hasUpdate === true) {
						state = "update"; text = (d.installed ? "v" + d.installed + " · " : "") + t("dshHasUpdateShort");
					} else if (d.checked === false) {
						state = "unknown"; text = d.installed ? "v" + d.installed : "";
					} else {
						state = "ok"; text = d.installed ? "v" + d.installed : "";
					}
					statusEl.dataset.state = state;
					statusEl.title = ""; // 不显示 hover 文案
					const ver = statusEl.querySelector(".pm-dshselfVersion");
					if (ver) ver.textContent = text;
				};

				let dshReportOverlay = null;
				const closeDshReport = () => {
					if (dshReportOverlay && dshReportOverlay.parentElement) dshReportOverlay.parentElement.removeChild(dshReportOverlay);
					dshReportOverlay = null;
				};
				// 判定弹窗：已分析（红/黄）点击时展示 verdict/summary/变更/受影响插件/详情
				const showDshReport = (d) => {
					closeDshReport();
					const overlay = document.createElement("div");
					overlay.className = "pm-overlay";
					overlay.style.zIndex = "1001";
					overlay.addEventListener("click", closeDshReport);
					const modal = document.createElement("div");
					modal.className = "pm-modal";
					modal.style.maxWidth = "560px";
					modal.addEventListener("click", (e) => e.stopPropagation());
					const title = document.createElement("p");
					title.className = "pm-modalTitle";
					const body = document.createElement("div");
					body.className = "pm-modalBody";
					if (d && (d.verdict === "safe" || d.verdict === "breaking")) {
						title.textContent = d.verdict === "breaking" ? tpl(t("dshBreaking"), { version: d.latest ?? "?" }) : tpl(t("dshHasUpdate"), { version: d.latest ?? "?" });
						if (d.verdict === "breaking") title.classList.add("danger");
						const sum = document.createElement("p");
						sum.className = "pm-modalText";
						sum.textContent = d.summary ?? "";
						body.appendChild(sum);
						if (Array.isArray(d.versions) && d.versions.length > 0) {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = tpl(t("dshReportVersions"), { count: String(d.versions.length) });
							body.appendChild(h);
							const ol = document.createElement("ol");
							ol.className = "pm-reviewRisks";
							ol.style.listStyle = "decimal";
							d.versions.forEach((v) => {
								const li = document.createElement("li");
								const head = document.createElement("span");
								head.style.fontWeight = "600";
								head.textContent = "v" + v.version + (v.breaking === true ? "（" + t("dshReportVersionBreaking") + "）" : "");
								li.appendChild(head);
								if (Array.isArray(v.changes) && v.changes.length > 0) {
									const ul = document.createElement("ul");
									ul.className = "pm-reviewRisks";
									v.changes.forEach((c) => { const sub = document.createElement("li"); sub.textContent = c; ul.appendChild(sub); });
									li.appendChild(ul);
								} else {
									const note = document.createElement("div");
									note.className = "pm-modalText";
									note.style.opacity = "0.7";
									note.textContent = v.missing === true ? t("dshReportVersionMissing") : t("dshReportVersionEmpty");
									li.appendChild(note);
								}
								ol.appendChild(li);
							});
							body.appendChild(ol);
						}
						if (Array.isArray(d.changes) && d.changes.length > 0) {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = t("dshReportChanges") + "：";
							body.appendChild(h);
							const ul = document.createElement("ul");
							ul.className = "pm-reviewRisks";
							d.changes.forEach((c) => { const li = document.createElement("li"); li.textContent = c; ul.appendChild(li); });
							body.appendChild(ul);
						}
						if (Array.isArray(d.affectedPlugins) && d.affectedPlugins.length > 0) {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = t("dshReportAffected") + "：";
							body.appendChild(h);
							const ul = document.createElement("ul");
							ul.className = "pm-reviewRisks";
							d.affectedPlugins.forEach((c) => { const li = document.createElement("li"); li.textContent = c; ul.appendChild(li); });
							body.appendChild(ul);
						}
						if (d.details) {
							const h = document.createElement("p");
							h.className = "pm-modalText";
							h.style.fontWeight = "600";
							h.textContent = t("dshReportDetails") + "：";
							body.appendChild(h);
							const p = document.createElement("p");
							p.className = "pm-modalText";
							p.textContent = d.details;
							body.appendChild(p);
						}
					} else {
						title.textContent = t("dshUnknown");
						const p = document.createElement("p");
						p.className = "pm-modalText";
						p.textContent = (d && typeof d.error === "string" && d.error !== "") ? d.error : t("dshUnknown");
						body.appendChild(p);
					}
					const row = document.createElement("div");
					row.className = "pm-modalRow";
					const ok = document.createElement("button");
					ok.className = "pm-btn primary";
					ok.textContent = t("ok");
					ok.addEventListener("click", closeDshReport);
					row.appendChild(ok);
					modal.appendChild(title);
					modal.appendChild(body);
					modal.appendChild(row);
					overlay.appendChild(modal);
					document.body.appendChild(overlay);
					dshReportOverlay = overlay;
				};

				const startPoll = (f) => {
					if (pollTimer !== null && fast === f) return;
					if (pollTimer !== null) clearInterval(pollTimer);
					fast = f;
					pollTimer = setInterval(fetchState, f ? FAST_POLL_MS : NORMAL_POLL_MS);
				};

				const fetchState = () => {
					fetch("/plugin-market/dsh-version", { cache: "no-store" })
						.then((r) => r.json())
						.then((d) => {
							paint(d);
							const analyzing = !!(d && d.status === "analyzing");
							if (analyzing !== fast) startPoll(analyzing);
						})
						.catch(() => {});
				};

				const onClick = () => {
					if (!statusEl || analyzeBusy) return;
					const state = statusEl.dataset.state;
					if (state === "analyzing") return; // 分析进行中：忽略重复点击（服务端同样不并发起第二次分析）
					if (state === "update" || state === "breaking") {
						// 已有判定 → 弹判定弹窗；待分析 → 静默直连 LLM 分析（不弹窗），完成后点击再看弹窗
						fetch("/plugin-market/dsh-version", { cache: "no-store" })
							.then((r) => r.json())
							.then((d) => {
								if (d && d.hasUpdate === true && (d.verdict === "safe" || d.verdict === "breaking")) {
									showDshReport(d);
									return;
								}
								analyzeBusy = true;
								statusEl.dataset.state = "analyzing";
								startPoll(true);
								fetch("/plugin-market/dsh-version/analyze", {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({}),
								})
									.then((r) => r.json())
									.then((d2) => { if (!d2 || d2.ok !== true) fetchState(); })
									.catch(() => fetchState())
									.finally(() => { analyzeBusy = false; });
							})
							.catch(() => fetchState());
					} else {
						// 绿/灰：手动重检
						fetch("/plugin-market/dsh-version/check", { method: "POST" })
							.then((r) => r.json())
							.then((d) => paint(d))
							.catch(() => fetchState());
					}
				};

				const syncCollapsed = (toggle) => {
					if (!statusEl) return;
					const label = toggle.getAttribute("aria-label") ?? "";
					statusEl.dataset.collapsed = /打开侧边栏|Open sidebar/.test(label) ? "true" : "false";
				};

				const mount = () => {
					const toggle = document.querySelector(TOGGLE_SEL);
					if (!toggle) return;
					const logoRow = toggle.parentElement;
					if (!logoRow) return;
					if (statusEl && statusEl.isConnected) { syncCollapsed(toggle); return; }
					statusEl = document.createElement("span");
					statusEl.className = "pm-dshself";
					statusEl.dataset.state = "unknown";
					statusEl.title = t("dshUnknown");
					const dot = document.createElement("span");
					dot.className = "pm-dshselfDot";
					const ver = document.createElement("span");
					ver.className = "pm-dshselfVersion";
					statusEl.appendChild(dot);
					statusEl.appendChild(ver);
					statusEl.addEventListener("click", onClick);
					logoRow.insertAdjacentElement("afterend", statusEl);
					syncCollapsed(toggle);
					if (attrObserver) attrObserver.disconnect();
					attrObserver = new MutationObserver(() => syncCollapsed(toggle));
					attrObserver.observe(toggle, { attributes: true, attributeFilter: ["aria-label"] });
					fetchState();
				};

				const schedule = () => {
					if (scanTimer !== null) clearTimeout(scanTimer);
					scanTimer = setTimeout(mount, 120);
				};

				observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
				mount();
				startPoll(false);

				return () => {
					closeDshReport();
					if (observer) observer.disconnect();
					if (attrObserver) attrObserver.disconnect();
					if (pollTimer !== null) clearInterval(pollTimer);
					if (scanTimer !== null) clearTimeout(scanTimer);
					if (statusEl && statusEl.parentElement) statusEl.parentElement.removeChild(statusEl);
					statusEl = null;
				};
			}, "plugin-market: dsh version light");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
