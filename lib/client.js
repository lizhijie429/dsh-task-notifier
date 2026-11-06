window.__ModuleLoader__.load({
	id: "@lizhijie429/dsh-task-notifier",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		/** Browser-side namespace for the settings page. */
		const NS = "task-notifier.settings";
		/** Host entry id whose configuration this page edits. */
		const ROW_NAMESPACE = "task-notifier";
		/** Package name used by the plugin manager's row slot key. */
		const PACKAGE_NAME = "@lizhijie429/dsh-task-notifier";

		/** Chinese copy. */
		const zh = {
			nav: "任务通知",
			title: "任务通知",
			subtitle: "任务结束、需要授权或需要你回答时发送系统通知，并在网络/模型失败后自动继续。",
			loading: "正在读取配置…",
			unavailable: "配置暂不可编辑：请确认插件已加载，且 Host 已为该插件提供设置命名空间。",
			readonly: "当前连接没有写入权限。",
			save: "保存",
			saving: "保存中…",
			reset: "放弃修改",
			saved: "已保存。",
			noChanges: "没有需要保存的修改。",
			conflict: "保存冲突或 Host 拒绝了修改，请刷新后重试。",
			saveFailed: "保存失败，请查看 DSH 日志。",
			required: "不能为空。",
			range: "数值超出允许范围。",
			invalidUrl: "只支持 dsh:、http:、https: 链接，或关闭点击动作。",
			retryCodes: "至少保留一个失败码。",
			clickEnable: "启用 Toast 点击动作",
			clickUrl: "点击目标",
			logFilePlaceholder: "留空使用插件目录下的默认日志路径",
			retryHint: "用逗号或换行分隔，例如 TRANSPORT, TIMEOUT。",
			footer: "保存后会写入 DSH 设置层并覆盖 profile patch 中的同名配置；插件可能重新加载。",
			sections: {
				notifications: "任务通知",
				actions: "需要你操作时的提醒",
				presentation: "显示与隐私",
				autoContinue: "自动继续",
				channel: "通知通道",
				debug: "调试日志",
			},
			sectionHints: {
				notifications: "选择哪些任务状态需要通知。",
				actions: "审批、提问和计划审批不区分 DSH 是否在前台，始终提醒。",
				presentation: "控制标题、文案语言、敏感信息与 Windows 点击行为。",
				autoContinue: "网络/模型请求失败后自动发送「继续」。",
				channel: "一般保持 auto；只有排障时才需要固定通道。",
				debug: "日志保留完整通知正文，分享前请自行脱敏。",
			},
			fields: {
				notifyOnStart: "任务开始",
				notifyOnComplete: "任务完成 / 输出上限",
				notifyOnError: "任务失败 / 阻塞 / 中断",
				notifyOnAbort: "任务取消",
				notifyOnStep: "每一步（调试）",
				notifySubagents: "子代理会话",
				notifyOnApproval: "审批等待",
				notifyOnQuestion: "模型提问 / 计划审批",
				approvalGraceMs: "审批宽限期（毫秒）",
				questionGraceMs: "提问宽限期（毫秒）",
				reminderMs: "重复提醒间隔（毫秒，0 关闭）",
				reminderMax: "最多提醒次数（0 只发首次）",
				actionSound: "审批/提问提示音",
				locale: "通知文案语言",
				titleSessionLabel: "标题附加短会话标签",
				privacyMode: "锁屏隐私模式",
				titlePrefix: "标题前缀",
				maxBodyChars: "正文最大字符数",
				includePreview: "附模型输出预览",
				clickUrl: "点击目标",
				channel: "通知通道",
				windowsAppId: "Windows AppUserModelID",
				windowsAppName: "Windows 应用名",
				logFile: "日志文件路径",
				"autoContinue.enabled": "启用自动继续",
				"autoContinue.message": "自动发送的消息",
				"autoContinue.maxAttempts": "每个任务最多继续次数",
				"autoContinue.cooldownMs": "两次继续的最小间隔（毫秒）",
				"autoContinue.requireRetryExhausted": "仅重试预算耗尽时继续",
				"autoContinue.respectProviderRetryAfter": "遵循 provider 重试等待",
				"autoContinue.retryableCodes": "可继续的失败码",
				autoContinue: {
					enabled: "启用自动继续",
					message: "自动发送的消息",
					maxAttempts: "每个任务最多继续次数",
					cooldownMs: "两次继续的最小间隔（毫秒）",
					requireRetryExhausted: "仅重试预算耗尽时继续",
					respectProviderRetryAfter: "遵循 provider 重试等待",
					retryableCodes: "可继续的失败码",
				},
			},
			options: {
				auto: "自动探测",
				windows: "Windows",
				macos: "macOS",
				linux: "Linux",
				log: "只写日志",
				none: "静默",
				zh: "中文",
				en: "English",
				"locale.auto": "跟随 Host",
				localeAuto: "跟随 Host",
			},
		};

		/** English copy. */
		const en = {
			nav: "Task Notifier",
			title: "Task Notifier",
			subtitle: "Send OS notifications when a task finishes or needs your approval/answer, and continue after network/model failures.",
			loading: "Loading configuration…",
			unavailable: "Configuration is not editable yet: make sure the plugin is mounted and the Host serves its settings namespace.",
			readonly: "This connection cannot write settings.",
			save: "Save",
			saving: "Saving…",
			reset: "Discard changes",
			saved: "Saved.",
			noChanges: "Nothing to save.",
			conflict: "The save conflicted or the Host rejected it; reload and try again.",
			saveFailed: "Save failed; see the DSH log.",
			required: "This field is required.",
			range: "The value is outside the allowed range.",
			invalidUrl: "Use a dsh:, http: or https: URL, or disable the click action.",
			retryCodes: "Keep at least one failure code.",
			clickEnable: "Enable the toast click action",
			clickUrl: "Click target",
			logFilePlaceholder: "Leave empty to use the default log path under the plugin directory",
			retryHint: "Separate codes with commas or newlines, e.g. TRANSPORT, TIMEOUT.",
			footer: "Saving writes the DSH settings layer over the profile patch; the plugin may reload.",
			sections: {
				notifications: "Task notifications",
				actions: "Action-needed alerts",
				presentation: "Presentation and privacy",
				autoContinue: "Auto-continue",
				channel: "Notification channel",
				debug: "Debug log",
			},
			sectionHints: {
				notifications: "Choose which terminal task states notify you.",
				actions: "Approvals, questions and plan reviews always alert, even when DSH is in the foreground.",
				presentation: "Title, copy language, sensitive details and the Windows click action.",
				autoContinue: "Submit “继续” automatically after network/model-request failures.",
				channel: "Keep auto normally; pin a channel only for troubleshooting.",
				debug: "The log keeps full notification bodies; redact it before sharing.",
			},
			fields: {
				notifyOnStart: "Task start",
				notifyOnComplete: "Task complete / output limit",
				notifyOnError: "Task failed / blocked / interrupted",
				notifyOnAbort: "Task cancelled",
				notifyOnStep: "Every step (debug)",
				notifySubagents: "Sub-agent sessions",
				notifyOnApproval: "Pending approval",
				notifyOnQuestion: "Question / plan review",
				approvalGraceMs: "Approval grace (ms)",
				questionGraceMs: "Question grace (ms)",
				reminderMs: "Reminder interval (ms, 0 disables)",
				reminderMax: "Max reminders (0 = first alert only)",
				actionSound: "Action alert sound",
				locale: "Notification copy language",
				titleSessionLabel: "Short session label in title",
				privacyMode: "Lock-screen privacy mode",
				titlePrefix: "Title prefix",
				maxBodyChars: "Body character limit",
				includePreview: "Include model output preview",
				clickUrl: "Click target",
				channel: "Notification channel",
				windowsAppId: "Windows AppUserModelID",
				windowsAppName: "Windows app name",
				logFile: "Log file path",
				"autoContinue.enabled": "Enable auto-continue",
				"autoContinue.message": "Prompt text",
				"autoContinue.maxAttempts": "Attempts per task",
				"autoContinue.cooldownMs": "Minimum spacing (ms)",
				"autoContinue.requireRetryExhausted": "Only continue exhausted retry budgets",
				"autoContinue.respectProviderRetryAfter": "Honor provider retry-after",
				"autoContinue.retryableCodes": "Eligible failure codes",
				autoContinue: {
					enabled: "Enable auto-continue",
					message: "Prompt text",
					maxAttempts: "Attempts per task",
					cooldownMs: "Minimum spacing (ms)",
					requireRetryExhausted: "Only continue exhausted retry budgets",
					respectProviderRetryAfter: "Honor provider retry-after",
					retryableCodes: "Eligible failure codes",
				},
			},
			options: {
				auto: "Auto-detect",
				windows: "Windows",
				macos: "macOS",
				linux: "Linux",
				log: "Log only",
				none: "Silent",
				zh: "Chinese",
				en: "English",
				"locale.auto": "Follow Host",
				localeAuto: "Follow Host",
			},
		};

		/** Fallback copy when the locale service is unavailable. */
		function fallbackDict() {
			try {
				const lang = globalThis?.document?.documentElement?.lang || globalThis?.navigator?.language || "";
				return /^en/i.test(lang) ? en : zh;
			} catch {
				return zh;
			}
		}

		/** Resolve a dotted dictionary key such as `sections.notifications`. */
		function lookup(dict, key) {
			let node = dict;
			for (const part of String(key).split(".")) {
				if (node === null || typeof node !== "object" || !(part in node)) return undefined;
				node = node[part];
			}
			return typeof node === "string" ? node : undefined;
		}

		/** Resolve one dictionary key with a readable fallback. */
		function makeTranslator(t) {
			const fallback = fallbackDict();
			return (key) => {
				try {
					const value = typeof t === "function" ? t(key) : undefined;
					if (typeof value === "string" && value.length > 0 && value !== key) return value;
				} catch {
					// fall through to the local dictionary
				}
				return lookup(fallback, key) ?? lookup(zh, key) ?? key;
			};
		}

		/** Client-side display defaults; the host remains authoritative on save. */
		const DEFAULT = {
			notifyOnStart: false,
			notifyOnComplete: true,
			notifyOnError: true,
			notifyOnAbort: false,
			notifyOnStep: false,
			notifySubagents: false,
			notifyOnApproval: true,
			approvalGraceMs: 1000,
			notifyOnQuestion: true,
			questionGraceMs: 1000,
			locale: "zh",
			reminderMs: 60000,
			reminderMax: 5,
			actionSound: true,
			clickUrl: "dsh://open",
			titleSessionLabel: true,
			privacyMode: false,
			channel: "auto",
			titlePrefix: "DSH",
			windowsAppId: "DSH.TaskNotifier",
			windowsAppName: "DSH",
			maxBodyChars: 240,
			includePreview: false,
			logFile: "",
			autoContinue: {
				enabled: true,
				message: "继续",
				maxAttempts: 3,
				cooldownMs: 5000,
				requireRetryExhausted: false,
				respectProviderRetryAfter: true,
				retryableCodes: [
					"EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "PI_AI_ERROR",
					"AI_ERROR", "PROVIDER", "MODEL", "OVERLOADED", "NETWORK", "CONNECTION",
					"ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "SOCKET",
				],
			},
		};

		const BOOLEAN_FIELDS = [
			"notifyOnStart", "notifyOnComplete", "notifyOnError", "notifyOnAbort", "notifyOnStep",
			"notifySubagents", "notifyOnApproval", "notifyOnQuestion", "actionSound",
			"titleSessionLabel", "privacyMode", "includePreview",
		];
		const NUMBER_FIELDS = [
			"approvalGraceMs", "questionGraceMs", "reminderMs", "reminderMax", "maxBodyChars",
		];
		const NUMBER_RULES = {
			approvalGraceMs: [0, 60000],
			questionGraceMs: [0, 60000],
			reminderMs: [0, 3600000],
			reminderMax: [0, 10],
			maxBodyChars: [60, 2000],
			"autoContinue.maxAttempts": [1, 50],
			"autoContinue.cooldownMs": [0, 600000],
			// `readNumber` also receives the nested autoContinue object; these
			// aliases keep its bounds attached to the bare field names.
			maxAttempts: [1, 50],
			cooldownMs: [0, 600000],
		};
		const AUTO_BOOLEAN_FIELDS = [
			"autoContinue.enabled", "autoContinue.requireRetryExhausted", "autoContinue.respectProviderRetryAfter",
		];

		/** Turn a settings snapshot value into editable draft state. */
		function toDraft(value) {
			const source = value && typeof value === "object" ? value : {};
			const draft = {};
			for (const key of BOOLEAN_FIELDS) draft[key] = source[key] ?? DEFAULT[key];
			for (const key of NUMBER_FIELDS) draft[key] = String(source[key] ?? DEFAULT[key]);
			draft.locale = source.locale ?? DEFAULT.locale;
			draft.channel = source.channel ?? DEFAULT.channel;
			draft.titlePrefix = source.titlePrefix ?? DEFAULT.titlePrefix;
			draft.windowsAppId = source.windowsAppId ?? DEFAULT.windowsAppId;
			draft.windowsAppName = source.windowsAppName ?? DEFAULT.windowsAppName;
			draft.logFile = typeof source.logFile === "string" ? source.logFile : "";
			const clickValue = source.clickUrl;
			draft.clickEnabled = clickValue !== false && clickValue !== "";
			draft.clickUrlText = typeof clickValue === "string" && clickValue.length > 0 ? clickValue : DEFAULT.clickUrl;
			const auto = source.autoContinue && typeof source.autoContinue === "object" ? source.autoContinue : {};
			draft.autoContinue = {
				enabled: auto.enabled ?? DEFAULT.autoContinue.enabled,
				message: auto.message ?? DEFAULT.autoContinue.message,
				maxAttempts: String(auto.maxAttempts ?? DEFAULT.autoContinue.maxAttempts),
				cooldownMs: String(auto.cooldownMs ?? DEFAULT.autoContinue.cooldownMs),
				requireRetryExhausted: auto.requireRetryExhausted ?? DEFAULT.autoContinue.requireRetryExhausted,
				respectProviderRetryAfter: auto.respectProviderRetryAfter ?? DEFAULT.autoContinue.respectProviderRetryAfter,
				retryableCodes: Array.isArray(auto.retryableCodes)
					? auto.retryableCodes.join(", ")
					: DEFAULT.autoContinue.retryableCodes.join(", "),
			};
			return draft;
		}

		/** Deep value comparison good enough for JSON-shaped config values. */
		function same(a, b) {
			if (a === b) return true;
			if (typeof a !== typeof b) return false;
			if (a === null || b === null) return a === b;
			if (Array.isArray(a) || Array.isArray(b)) {
				if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
				return a.every((item, index) => same(item, b[index]));
			}
			if (typeof a === "object" && typeof b === "object") {
				const ak = Object.keys(a);
				const bk = Object.keys(b);
				if (ak.length !== bk.length) return false;
				return ak.every((key) => Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]));
			}
			return false;
		}

		/** Parse and validate one integer field. */
		function readNumber(draft, key, label, tr) {
			const raw = String(draft[key] ?? "").trim();
			const value = Number(raw);
			const [min, max] = NUMBER_RULES[key] ?? [0, Number.MAX_SAFE_INTEGER];
			if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: ${tr("range")}`);
			return value;
		}

		/** Build the atomic settings mutation for the current draft. */
		function buildOps(draft, snapshot, tr) {
			const effective = snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
			const user = snapshot.user && typeof snapshot.user === "object" ? snapshot.user : {};
			const ops = [];
			const next = {};

			for (const key of BOOLEAN_FIELDS) next[key] = Boolean(draft[key]);
			for (const key of NUMBER_FIELDS) next[key] = readNumber(draft, key, tr(`fields.${key}`), tr);
			next.locale = draft.locale;
			next.channel = draft.channel;
			next.titlePrefix = String(draft.titlePrefix ?? "").trim();
			if (next.titlePrefix.length === 0) throw new Error(`${tr("fields.titlePrefix")}: ${tr("required")}`);
			next.windowsAppId = String(draft.windowsAppId ?? "").trim();
			if (next.windowsAppId.length === 0) throw new Error(`${tr("fields.windowsAppId")}: ${tr("required")}`);
			next.windowsAppName = String(draft.windowsAppName ?? "").trim();
			if (next.windowsAppName.length === 0) throw new Error(`${tr("fields.windowsAppName")}: ${tr("required")}`);
			next.clickUrl = draft.clickEnabled ? String(draft.clickUrlText ?? "").trim() : false;
			if (next.clickUrl !== false && !/^(dsh|https?):/i.test(next.clickUrl)) throw new Error(tr("invalidUrl"));
			next.logFile = String(draft.logFile ?? "").trim();

			const autoMessage = String(draft.autoContinue.message ?? "").trim();
			if (autoMessage.length === 0) throw new Error(`${tr("fields.autoContinue.message")}: ${tr("required")}`);
			const codes = String(draft.autoContinue.retryableCodes ?? "")
				.split(/[\s,;]+/)
				.map((code) => code.trim())
				.filter((code) => code.length > 0);
			if (codes.length === 0) throw new Error(tr("retryCodes"));
			next.autoContinue = {
				enabled: Boolean(draft.autoContinue.enabled),
				message: autoMessage,
				maxAttempts: readNumber(draft.autoContinue, "maxAttempts", tr("fields.autoContinue.maxAttempts"), tr),
				cooldownMs: readNumber(draft.autoContinue, "cooldownMs", tr("fields.autoContinue.cooldownMs"), tr),
				requireRetryExhausted: Boolean(draft.autoContinue.requireRetryExhausted),
				respectProviderRetryAfter: Boolean(draft.autoContinue.respectProviderRetryAfter),
				retryableCodes: codes,
			};

			for (const key of Object.keys(next)) {
				if (key === "logFile" || key === "autoContinue" || key === "clickUrl") continue;
				if (!same(next[key], effective[key])) ops.push({ op: "set", path: [key], value: next[key] });
			}
			const effectiveClick = effective.clickUrl === false || effective.clickUrl === "" ? false : effective.clickUrl;
			if (!same(next.clickUrl, effectiveClick)) ops.push({ op: "set", path: ["clickUrl"], value: next.clickUrl });

			const effectiveAuto = effective.autoContinue && typeof effective.autoContinue === "object"
				? effective.autoContinue
				: {};
			for (const key of Object.keys(next.autoContinue)) {
				if (!same(next.autoContinue[key], effectiveAuto[key])) {
					ops.push({ op: "set", path: ["autoContinue", key], value: next.autoContinue[key] });
				}
			}

			if (next.logFile.length === 0) {
				if (Object.prototype.hasOwnProperty.call(user, "logFile")) ops.push({ op: "unset", path: ["logFile"] });
			} else if (!same(next.logFile, effective.logFile)) {
				ops.push({ op: "set", path: ["logFile"], value: next.logFile });
			}
			return ops;
		}

		const styles = {
			page: { display: "grid", gap: "18px", color: "inherit", font: "inherit", maxWidth: "880px" },
			header: { display: "grid", gap: "6px" },
			title: { margin: 0, fontSize: "20px", lineHeight: "28px", fontWeight: 600 },
			subtitle: { margin: 0, color: "var(--dsh-text-secondary, rgba(127,127,127,.95))", fontSize: "13px", lineHeight: "20px" },
			note: { margin: 0, color: "var(--dsh-text-secondary, rgba(127,127,127,.95))", fontSize: "12px", lineHeight: "18px" },
			error: { margin: 0, color: "var(--dsh-danger-color, #d9534f)", fontSize: "12px", lineHeight: "18px" },
			success: { margin: 0, color: "var(--dsh-success-color, #3fa45b)", fontSize: "12px", lineHeight: "18px" },
			section: {
				border: "1px solid var(--dsh-border-color, rgba(127,127,127,.28))",
				borderRadius: "10px",
				padding: "14px 16px",
				display: "grid",
				gap: "12px",
			},
			sectionHead: { display: "grid", gap: "2px" },
			sectionTitle: { margin: 0, fontSize: "14px", fontWeight: 600 },
			sectionHint: { margin: 0, color: "var(--dsh-text-secondary, rgba(127,127,127,.95))", fontSize: "12px", lineHeight: "18px" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px 18px" },
			row: { display: "grid", gap: "5px", minWidth: 0 },
			label: { fontSize: "12px", lineHeight: "16px", color: "var(--dsh-text-secondary, rgba(127,127,127,.98))" },
			input: {
				width: "100%",
				boxSizing: "border-box",
				padding: "7px 9px",
				borderRadius: "7px",
				border: "1px solid var(--dsh-border-color, rgba(127,127,127,.32))",
				background: "var(--dsh-input-background, rgba(127,127,127,.08))",
				color: "inherit",
				font: "inherit",
				fontSize: "13px",
			},
			textarea: { minHeight: "64px", resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
			check: { display: "flex", alignItems: "center", gap: "8px", minHeight: "30px", fontSize: "13px" },
			hint: { margin: 0, color: "var(--dsh-text-secondary, rgba(127,127,127,.9))", fontSize: "11px", lineHeight: "16px" },
			footer: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px" },
			primary: {
				padding: "7px 16px",
				borderRadius: "7px",
				border: "1px solid var(--dsh-accent-color, #4c8dff)",
				background: "var(--dsh-accent-color, #4c8dff)",
				color: "#fff",
				font: "inherit",
				fontSize: "13px",
				cursor: "pointer",
			},
			secondary: {
				padding: "7px 16px",
				borderRadius: "7px",
				border: "1px solid var(--dsh-border-color, rgba(127,127,127,.32))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "13px",
				cursor: "pointer",
			},
		};

		/** Render one labelled control row. */
		function Row(label, control, hint) {
			return h("div", { style: styles.row }, h("label", { style: styles.label }, label), control, hint ? h("p", { style: styles.hint }, hint) : null);
		}

		/** Render one checkbox row. */
		function CheckRow(label, checked, onChange) {
			return h(
				"label",
				{ style: styles.check },
				h("input", { type: "checkbox", checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
				h("span", null, label),
			);
		}

		/** Settings form shared by the Settings section and the plugin-row page. */
		function Page(props) {
			const { form, tr, showHeader } = props;
			const subscribe = React.useCallback((listener) => form.subscribe(listener), [form]);
			const read = React.useCallback(() => form.getSnapshot(), [form]);
			const snapshot = React.useSyncExternalStore(subscribe, read, read);
			const [draft, setDraft] = React.useState(() => (snapshot.status === "ready" ? toDraft(snapshot.value) : null));
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(null);

			React.useEffect(() => {
				if (snapshot.status === "ready") {
					setDraft(toDraft(snapshot.value));
					setMessage(null);
				}
			}, [snapshot.status, snapshot.revision]);

			if (snapshot.status === "loading") {
				return h("div", { style: styles.page }, showHeader ? h(Header, { tr }) : null, h("p", { style: styles.note }, tr("loading")));
			}
			if (snapshot.status === "unavailable" || draft === null) {
				return h("div", { style: styles.page }, showHeader ? h(Header, { tr }) : null, h("p", { style: styles.note }, tr("unavailable")));
			}
			const writable = snapshot.writable !== false;
			const set = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }));
			const setAuto = (key, value) => setDraft((previous) => ({
				...previous,
				autoContinue: { ...previous.autoContinue, [key]: value },
			}));
			const onSave = async () => {
				setBusy(true);
				setMessage(null);
				try {
					const ops = buildOps(draft, snapshot, tr);
					if (ops.length === 0) {
						setMessage({ kind: "note", text: tr("noChanges") });
						return;
					}
					const accepted = await form.mutate(ops, snapshot.revision);
					setMessage(accepted ? { kind: "success", text: tr("saved") } : { kind: "error", text: tr("conflict") });
					if (accepted) setDraft(toDraft(form.getSnapshot().value));
				} catch (error) {
					setMessage({ kind: "error", text: String(error?.message ?? error) || tr("saveFailed") });
				} finally {
					setBusy(false);
				}
			};
			const onReset = () => {
				setDraft(toDraft(snapshot.value));
				setMessage(null);
			};

			const section = (id, ...children) => h(
				"section",
				{ style: styles.section },
				h("header", { style: styles.sectionHead },
					h("h3", { style: styles.sectionTitle }, tr(`sections.${id}`)),
					h("p", { style: styles.sectionHint }, tr(`sectionHints.${id}`)),
				),
				h("div", { style: styles.grid }, ...children),
			);

			const input = (key, extra = {}) => h("input", {
				type: "text",
				style: styles.input,
				value: draft[key] ?? "",
				disabled: !writable,
				onChange: (event) => set(key, event.target.value),
				...extra,
			});
			const checkbox = (key) => CheckRow(tr(`fields.${key}`), draft[key], (value) => set(key, value));
			const number = (key) => input(key, { type: "number", min: NUMBER_RULES[key]?.[0], max: NUMBER_RULES[key]?.[1] });

			return h(
				"div",
				{ style: styles.page },
				showHeader ? h(Header, { tr }) : null,
				section("notifications",
					checkbox("notifyOnStart"), checkbox("notifyOnComplete"), checkbox("notifyOnError"),
					checkbox("notifyOnAbort"), checkbox("notifyOnStep"), checkbox("notifySubagents"),
					checkbox("notifyOnApproval"), checkbox("notifyOnQuestion"),
				),
				section("actions",
					Row(tr("fields.approvalGraceMs"), number("approvalGraceMs")),
					Row(tr("fields.questionGraceMs"), number("questionGraceMs")),
					Row(tr("fields.reminderMs"), number("reminderMs")),
					Row(tr("fields.reminderMax"), number("reminderMax")),
					checkbox("actionSound"),
				),
				section("presentation",
					Row(tr("fields.locale"), h("select", {
						style: styles.input,
						value: draft.locale,
						disabled: !writable,
						onChange: (event) => set("locale", event.target.value),
					}, ["zh", "en", "auto"].map((value) => h("option", { key: value, value }, tr(value === "auto" ? "options.localeAuto" : `options.${value}`)))),
					),
					checkbox("titleSessionLabel"), checkbox("privacyMode"),
					Row(tr("fields.titlePrefix"), input("titlePrefix")),
					Row(tr("fields.maxBodyChars"), number("maxBodyChars")),
					checkbox("includePreview"),
					CheckRow(tr("clickEnable"), draft.clickEnabled, (value) => set("clickEnabled", value)),
					draft.clickEnabled
						? Row(tr("clickUrl"), h("input", {
							type: "text",
							style: styles.input,
							value: draft.clickUrlText,
							disabled: !writable,
							onChange: (event) => set("clickUrlText", event.target.value),
						}))
						: null,
				),
				section("autoContinue",
					CheckRow(tr("fields.autoContinue.enabled"), draft.autoContinue.enabled, (value) => setAuto("enabled", value)),
					Row(tr("fields.autoContinue.message"), h("input", {
						type: "text",
						style: styles.input,
						value: draft.autoContinue.message,
						disabled: !writable,
						onChange: (event) => setAuto("message", event.target.value),
					})),
					Row(tr("fields.autoContinue.maxAttempts"), h("input", {
						type: "number",
						min: 1,
						max: 50,
						style: styles.input,
						value: draft.autoContinue.maxAttempts,
						disabled: !writable,
						onChange: (event) => setAuto("maxAttempts", event.target.value),
					})),
					Row(tr("fields.autoContinue.cooldownMs"), h("input", {
						type: "number",
						min: 0,
						max: 600000,
						style: styles.input,
						value: draft.autoContinue.cooldownMs,
						disabled: !writable,
						onChange: (event) => setAuto("cooldownMs", event.target.value),
					})),
					CheckRow(tr("fields.autoContinue.requireRetryExhausted"), draft.autoContinue.requireRetryExhausted, (value) => setAuto("requireRetryExhausted", value)),
					CheckRow(tr("fields.autoContinue.respectProviderRetryAfter"), draft.autoContinue.respectProviderRetryAfter, (value) => setAuto("respectProviderRetryAfter", value)),
					Row(tr("fields.autoContinue.retryableCodes"), h("textarea", {
						style: { ...styles.input, ...styles.textarea },
						value: draft.autoContinue.retryableCodes,
						disabled: !writable,
						onChange: (event) => setAuto("retryableCodes", event.target.value),
					}), tr("retryHint")),
				),
				section("channel",
					Row(tr("fields.channel"), h("select", {
						style: styles.input,
						value: draft.channel,
						disabled: !writable,
						onChange: (event) => set("channel", event.target.value),
					}, ["auto", "windows", "macos", "linux", "log", "none"].map((value) => h("option", { key: value, value }, tr(`options.${value}`)))),
					),
					Row(tr("fields.windowsAppId"), input("windowsAppId")),
					Row(tr("fields.windowsAppName"), input("windowsAppName")),
				),
				section("debug",
					Row(tr("fields.logFile"), input("logFile", { placeholder: tr("logFilePlaceholder") }), tr("logFilePlaceholder")),
				),
				!writable ? h("p", { style: styles.note }, tr("readonly")) : null,
				message ? h("p", { style: message.kind === "error" ? styles.error : message.kind === "success" ? styles.success : styles.note }, message.text) : null,
				h("div", { style: styles.footer },
					h("button", { type: "button", style: styles.primary, disabled: busy || !writable, onClick: onSave }, busy ? tr("saving") : tr("save")),
					h("button", { type: "button", style: styles.secondary, disabled: busy || !writable, onClick: onReset }, tr("reset")),
					h("p", { style: styles.note }, tr("footer")),
				),
			);
		}

		/** Page header shared by the Settings section. */
		function Header({ tr }) {
			return h("div", { style: styles.header },
				h("h2", { style: styles.title }, tr("title")),
				h("p", { style: styles.subtitle }, tr("subtitle")),
			);
		}

		/** Settings section: always reachable from the DSH Settings sidebar. */
		function SettingsSection(props) {
			const { form, tr } = props;
			if (!form) return h("p", { style: styles.note }, tr("unavailable"));
			return h(Page, { form, tr, showHeader: true });
		}

		/** Plugin-manager row configuration page. */
		function RowConfigPage(props) {
			const { form, tr, view } = props;
			if (view && view !== "page") return null;
			if (!form) return h("p", { style: styles.note }, tr("unavailable"));
			return h(Page, { form, tr, showHeader: false });
		}

		/** Required client services. */
		const inject = ["slots", "locale", "configForms"];

		/** Mount the settings surfaces. */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			const tr = makeTranslator(t);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "task-notifier: settings locale");

			let form;
			try {
				form = ctx.configForms.get(ROW_NAMESPACE);
			} catch {
				form = undefined;
			}

			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "task-notifier",
				order: 60,
				label: () => tr("nav"),
				locale: NS,
			}, (props) => h(SettingsSection, { ...props, form, tr }))), "task-notifier: settings section");

			ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: `${PACKAGE_NAME}#${ROW_NAMESPACE}`,
				locale: NS,
			}, (props) => h(RowConfigPage, { ...props, tr }))), "task-notifier: row config page");
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});

