// Dashboard i18n (#700): the ONLY place UI strings live. Every dashboard asset
// pulls its text from DICT via t(); the guard test (dashboard-i18n-guard) fails
// the build if an Arabic literal appears anywhere else in the dashboard assets.
// Language resolution: localStorage "devlog-lang" wins; otherwise the server's
// default (DEVLOG_LANG) stamped on <html data-default-lang> at serve time
// (routes-static #701); "ar" as the last-resort default (historic behavior).
// Import-safe under bun test: no DOM/localStorage access at module load.

export const DICT = {
  // ===== dialogs / shared =====
  "core.alertTitle": { en: "Notice", ar: "تنبيه" },
  "core.confirmTitle": { en: "Confirm", ar: "تأكيد" },
  "core.confirmOk": { en: "Yes, do it", ar: "نعم، نفّذ" },
  "core.cancel": { en: "Cancel", ar: "إلغاء" },
  "core.promptTitle": { en: "Input", ar: "إدخال" },
  "core.promptOk": { en: "OK", ar: "موافق" },
  "core.ok": { en: "OK", ar: "حسنًا" },
  "core.close": { en: "Close", ar: "إغلاق" },
  "core.errorMsg": { en: "Error: {msg}", ar: "خطأ: {msg}" },
  "core.deleteForever": { en: "Delete permanently", ar: "احذف نهائيًا" },
  "core.deleteFailed": { en: "Delete failed", ar: "فشل الحذف" },
  "core.deleteTagConfirm": {
    en: "Delete this {label} permanently?\nUse this only for a false positive or a mistaken entry. For a real fix use -(security fix) #N or -(bug fix) #N.",
    ar: "حذف هذه الـ{label} نهائياً؟\nاستخدم هذا فقط للـfalse positive أو الإدخال الخاطئ. للإصلاح الفعلي استخدم -(security fix) #N أو -(bug fix) #N.",
  },
  "tag.security": { en: "vulnerability", ar: "ثغرة" },
  "tag.bug": { en: "bug", ar: "خلل" },
  "tag.generic": { en: "tag", ar: "تاق" },
  "core.stepsInPlan": { en: "{code} — {n} steps in \"{title}\"", ar: "{code} — {n} خطوة في \"{title}\"" },
  "core.openedAt": { en: "Opened: {ts}", ar: "فُتحت: {ts}" },
  "misc.loading": { en: "Loading…", ar: "جاري التحميل…" },
  "lang.toggle": { en: "🌐 عربي", ar: "🌐 EN" },
  "lang.toggleTitle": { en: "التبديل إلى العربية", ar: "Switch to English" },

  // ===== tag / filter labels =====
  "tagLabel.plan": { en: "Plan", ar: "خطة" },
  "tagLabel.built": { en: "Built", ar: "بناء" },
  "tagLabel.todo": { en: "Task", ar: "مهمة" },
  "tagLabel.done": { en: "Done", ar: "منجز" },
  "tagLabel.dropped": { en: "Dropped", ar: "ملغي" },
  "tagLabel.bug found": { en: "Bug", ar: "خلل" },
  "tagLabel.bug fix": { en: "Fix", ar: "إصلاح" },
  "tagLabel.security": { en: "Security", ar: "أمني" },
  "tagLabel.security fix": { en: "Security fix", ar: "إصلاح أمني" },
  "tagLabel.release": { en: "Release", ar: "إصدار" },
  "tagLabel.note": { en: "Note", ar: "ملاحظة" },
  "tagLabel.update": { en: "Update", ar: "تحديث" },
  "tagLabel.refactor": { en: "Refactor", ar: "إعادة هيكلة" },
  "tagLabel.outdated": { en: "Outdated", ar: "قديم" },
  "tagLabel.decision": { en: "Decision", ar: "قرار" },
  "tagLabel.insight": { en: "Insight", ar: "تحقيق" },
  "tagLabel.security:dep": { en: "Security (dep)", ar: "أمني (تبعية)" },
  "tagLabel.security:own": { en: "Security (code)", ar: "أمني (كود)" },
  "tagLabel.feature": { en: "Feature", ar: "ميزة" },
  "tagLabel.feature update": { en: "Feature update", ar: "تحديث ميزة" },
  "tagLabel.feature removed": { en: "Feature removed", ar: "ميزة أُزيلت" },
  "tagLabel.lib": { en: "Library", ar: "مكتبة" },
  "filter.all": { en: "All", ar: "الكل" },
  "filter.build": { en: "Build", ar: "البناء" },
  "filter.bugs": { en: "Bugs", ar: "الأخطاء" },
  "filter.security": { en: "Security", ar: "الأمان" },
  "filter.tasks": { en: "Tasks", ar: "المهام" },
  "filter.knowledge": { en: "Knowledge", ar: "معرفة" },
  "filter.other": { en: "Other", ar: "أخرى" },

  // ===== hover popovers =====
  "pop.empty": { en: "(empty)", ar: "(فارغ)" },
  "pop.emptyRescan": { en: "(empty — a rescan may be needed)", ar: "(فارغ — قد تحتاج إعادة مسح)" },
  "pop.noAbout": {
    en: "No about content for this project. Send `-(about) ...` to add it.",
    ar: "لا يوجد محتوى about لهذا المشروع. أرسل `-(about) ...` لإضافته.",
  },
  "pop.lastRelease": { en: "Latest release", ar: "آخر إصدار" },
  "pop.releasedAt": { en: "Released {when} — click to open the releases page", ar: "صدر {when} — اضغط لفتح صفحة الريليزات" },

  // ===== vulnerability modal / scan =====
  "vuln.fixLine": { en: "Upgrade to <b>{ver}</b> {rest}", ar: "رقِّ لـ <b>{ver}</b> {rest}" },
  "vuln.someNoFix": { en: "(some remain unfixed)", ar: "(يبقى بعضها بلا إصلاح)" },
  "vuln.closesAll": { en: "to close them all", ar: "لإغلاقها كلها" },
  "vuln.unmaintained": { en: "unmaintained", ar: "غير مُصان" },
  "vuln.unsound": { en: "unsound", ar: "غير سليم (unsound)" },
  "vuln.notice": { en: "notice", ar: "إشعار" },
  "vuln.noFix": { en: "no fix", ar: "لا إصلاح" },
  "vuln.noDetails": { en: "details unavailable", ar: "تفاصيل غير متوفّرة" },
  "vuln.scanHint": { en: "Run a security scan for per-CVE details.", ar: "اضغط «افحص الآن» لتفاصيل كل ثغرة." },
  "vuln.modalTitle": { en: "Vulnerabilities — {lib}", ar: "ثغرات {lib}" },
  "vuln.clickDetails": { en: "{text} — click for vulnerability details", ar: "{text} — اضغط لتفاصيل الثغرات" },
  "vuln.scanBtn": { en: "Security scan", ar: "فحص أمني" },
  "vuln.scanning": { en: "Scanning...", ar: "جاري الفحص..." },
  "vuln.connecting": { en: "Contacting the scan server...", ar: "جاري الاتصال بسيرفر الفحص..." },
  "vuln.badStatus": { en: "Unexpected server response (HTTP {status})", ar: "استجابة غير متوقعة من السيرفر (HTTP {status})" },
  "vuln.analyzing": { en: "Results received, analyzing...", ar: "تم استلام النتائج، جاري التحليل..." },
  "vuln.badJson": { en: "Failed to read the server response (invalid JSON)", ar: "فشل قراءة استجابة السيرفر (JSON غير صالح)" },
  "vuln.safeCount": { en: "{n} safe", ar: "{n} آمنة" },
  "vuln.updateCount": { en: "{n} need updates", ar: "{n} تحتاج تحديث" },
  "vuln.dangerCount": { en: "{n} dangerous", ar: "{n} خطيرة" },
  "vuln.unknownCount": { en: "{n} indeterminate", ar: "{n} غير محسومة" },
  "vuln.nothing": { en: "No libraries to scan", ar: "لا توجد مكتبات لفحصها" },
  "vuln.connFailMsg": { en: "Scan server connection failed — {msg}", ar: "فشل الاتصال بسيرفر الفحص — {msg}" },
  "vuln.connFail": { en: "Scan server connection failed (make sure the scan service is running)", ar: "فشل الاتصال بسيرفر الفحص (تأكد من تشغيل خدمة الفحص)" },
  "scan.rescan": { en: "Rescan", ar: "إعادة مسح" },
  "scan.scanning": { en: "Scanning...", ar: "جاري المسح..." },

  // ===== cards =====
  "card.tags": { en: "TAGS", ar: "التاقات" },
  "card.noTags": { en: "No tags", ar: "لا توجد تاقات" },
  "card.fullHistory": { en: "Show full history ({n} tags)", ar: "عرض كامل التاريخ ({n} تاق)" },
  "card.todos": { en: "TASKS", ar: "المهام" },
  "card.plans": { en: "ACTIVE PLANS", ar: "الخطط النشطة" },
  "card.changes": { en: "CODE CHANGES", ar: "التغييرات في الكود" },
  "card.files": { en: "FILES", ar: "الملفات" },
  "card.noFiles": { en: "No files", ar: "لا توجد ملفات" },
  "card.treeFail": { en: "Failed to load the file tree", ar: "تعذّر تحميل شجرة الملفات" },
  "card.events": { en: "EVENTS", ar: "الأحداث" },
  "card.noEvents": { en: "No events", ar: "لا توجد أحداث" },
  "card.docs": { en: "MEMORY & DOCS", ar: "الذاكرة والتوثيق" },
  "card.addedAt": { en: "Added: {ts}", ar: "أُضيف: {ts}" },

  // ===== errors =====
  "err.fetchProject": { en: "Couldn't fetch project \"{name}\" from the server", ar: "تعذّر جلب بيانات المشروع \"{name}\" من الخادم" },
  "err.retry": { en: "Retry", ar: "أعد المحاولة" },
  "err.unknown": { en: "unknown", ar: "غير معروف" },
  "err.failedMsg": { en: "Failed: {msg}", ar: "فشل: {msg}" },
  "err.connServer": { en: "Server connection failed: {msg}", ar: "فشل الاتصال بالخادم: {msg}" },
  "err.connGeneric": { en: "Couldn't reach the server", ar: "تعذّر الاتصال بالخادم" },

  // ===== daemon freshness =====
  "fresh.stale": {
    en: "The server is running code older than what's on disk — restart to pick up the update",
    ar: "الخادم يشغّل نسخة أقدم من الكود الموجود على القرص — أعد التشغيل لاستلام التحديث",
  },
  "fresh.restart": { en: "Restart server", ar: "إعادة تشغيل الخادم" },
  "fresh.restarting": { en: "Restarting…", ar: "يعيد التشغيل…" },
  "fresh.failed": { en: "Restart failed — restart the server manually", ar: "تعذّرت الإعادة — أعد تشغيل الخادم يدويًا" },

  // ===== tabs / relative days =====
  "tabs.current": { en: "Current", ar: "الحالية" },
  "tabs.upcoming": { en: "Upcoming", ar: "القادمة" },
  "days.today": { en: "today", ar: "اليوم" },
  "days.yesterday": { en: "yesterday", ar: "أمس" },
  "days.one": { en: "1 day ago", ar: "منذ يوم" },
  "days.two": { en: "2 days ago", ar: "منذ يومين" },
  "days.n": { en: "{d} days ago", ar: "منذ {d} يوم" },
  "days.before": { en: "{d} days ago", ar: "قبل {d} يوم" },

  // ===== security card =====
  "sec.fragile": { en: "MOST FRAGILE", ar: "الأكثر كسرًا" },
  "sec.fragileTitle": { en: "Appeared in {n} bug/security reports", ar: "ظهر في {n} بلاغ خلل/أمان" },
  "sec.fragileOpen": { en: " — {n} of them still open", ar: " — منها {n} ما زال مفتوحًا" },
  "sec.none": { en: "No security issues", ar: "لا توجد مشاكل أمنية" },
  "sec.open": { en: "open", ar: "مفتوحة" },
  "sec.fixed": { en: "fixed", ar: "مُصلحة" },
  "sec.outdated": { en: "outdated", ar: "قديمة" },
  "sec.fixReleased": { en: "fix released", ar: "صدر الفيكس" },
  "sec.latestReleased": { en: "new version released", ar: "صدر الإصدار الجديد" },
  "sec.daysAgoPart": { en: " {d} days ago", ar: " منذ {d} يوم" },
  "sec.reopenTitle": {
    en: "Possible reopen of closed report #{n} — check the old fix for regression",
    ar: "إعادة فتح محتملة للبلاغ المغلق #{n} — افحص انتكاس الإصلاح القديم",
  },
  "sec.delTitle": { en: "Permanent delete (for a false positive or mistaken entry)", ar: "حذف نهائي (لـfalse positive أو إدخال خاطئ)" },
  "sec.openVulns": { en: "Open vulnerabilities", ar: "ثغرات مفتوحة" },
  "sec.openBugs": { en: "Open bugs", ar: "أخطاء مفتوحة" },
  "sec.outdatedLibs": { en: "Outdated libraries", ar: "مكتبات قديمة" },
  "sec.fixedVulns": { en: "Fixed vulnerabilities", ar: "ثغرات مُصلحة" },
  "sec.fixedBugs": { en: "Fixed bugs", ar: "أخطاء مُصلحة" },

  // ===== tasks card =====
  "todos.emptyUpcoming": {
    en: "No upcoming items — create one with <code style=\"color:var(--gold)\">-(upcoming)</code> or defer a task with <code style=\"color:var(--gold)\">-(upcoming) #N</code>",
    ar: "لا توجد عناصر قادمة — أنشئ واحدًا بـ<code style=\"color:var(--gold)\">-(upcoming)</code> أو حوّل مهمة بـ<code style=\"color:var(--gold)\">-(upcoming) #N</code>",
  },
  "todos.empty": { en: "No tasks", ar: "لا توجد مهام" },

  // ===== sessions / processes =====
  "sess.bgCount": { en: "{n} background processes", ar: "{n} عملية خلفية" },
  "sess.orphanCount": { en: "{n} orphaned", ar: "{n} معلّقة" },
  "sess.startedAt": { en: "started: {date}", ar: "بدأت: {date}" },
  "sess.none": { en: "No active sessions", ar: "لا توجد جلسات نشطة" },
  "sess.kill": { en: "Kill", ar: "قتل" },
  "sess.title": { en: "Sessions & processes: {name}", ar: "جلسات وعمليات: {name}" },
  "sess.claudeActive": { en: "🟢 Active Claude sessions ({n})", ar: "🟢 جلسات Claude نشطة ({n})" },
  "sess.bgActive": { en: "⚙️ Active background processes ({n})", ar: "⚙️ عمليات خلفية نشطة ({n})" },
  "sess.noneShort": { en: "None", ar: "لا توجد" },
  "sess.orphaned": { en: "⚠️ Orphaned processes from closed sessions ({n})", ar: "⚠️ عمليات معلّقة من جلسات مغلقة ({n})" },
  "sess.refresh": { en: "Refresh", ar: "تحديث" },
  "sess.killConfirm": { en: "Kill process {pid}?", ar: "قتل العملية {pid}؟" },
  "sess.killOk": { en: "Kill process", ar: "اقتل العملية" },
  "sess.refreshFail": { en: "Failed to refresh processes: {msg}", ar: "فشل تحديث العمليات: {msg}" },

  // ===== model stats =====
  "models.title": { en: "Model performance: {name} 🤖", ar: "أداء النماذج: {name} 🤖" },
  "models.explainer": {
    en: "From the project's actual log: every tag is attributed to the model that wrote it (since v3.30.0). \"Regressed\" = its fix was later reopened ⟲ · \"No test\" = fixes that touched no test file, out of those judgeable.",
    ar: "من سجل المشروع الفعلي: كل تاق منسوب للنموذج الذي كتبه (منذ v3.30.0). «انتكس» = إصلاحه عاد وانفتح ⟲ · «بلا اختبار» = إصلاحات لم تلمس ملف اختبار من أصل القابل للحكم.",
  },
  "models.thModel": { en: "Model", ar: "النموذج" },
  "models.thTags": { en: "Tags", ar: "التاقات" },
  "models.thOpened": { en: "Reports opened", ar: "فتح بلاغات" },
  "models.thClosures": { en: "Closures", ar: "إغلاقات" },
  "models.thFixes": { en: "Fixes", ar: "إصلاحات" },
  "models.thReopened": { en: "Regressed ⟲", ar: "انتكس ⟲" },
  "models.thNoTest": { en: "No test", ar: "بلا اختبار" },
  "models.thAvgDays": { en: "Avg close (days)", ar: "متوسط الإغلاق (يوم)" },
  "models.empty": {
    en: "No attributed tags yet — attribution works from v3.30.0 onward; the board fills up with upcoming work.",
    ar: "لا تاقات منسوبة بعد — النسب يعمل من v3.30.0 وصاعدًا، واللوحة تمتلئ مع الشغل القادم.",
  },
  "models.unattributed": {
    en: "{n} historic tags without attribution (pre-dating this feature) — not counted in the table.",
    ar: "{n} تاق تاريخي بلا نسب (سابق لميزة النسب) — غير محسوب في الجدول.",
  },

  // ===== stat numbers / progress =====
  "stats.built": { en: "built", ar: "بناء" },
  "stats.todos": { en: "tasks", ar: "مهام" },
  "stats.bugs": { en: "bugs", ar: "خلل" },
  "stats.sec": { en: "security", ar: "أمني" },
  "stats.outdated": { en: "outdated", ar: "قديمة" },
  "stats.staleKept": {
    en: "Stale verdicts — /api/verdicts refresh failed; showing the last good snapshot",
    ar: "أحكام قديمة — تعذّر تحديث /api/verdicts؛ تُعرض آخر لقطة سليمة",
  },
  "stats.staleOpen": {
    en: "Couldn't fetch /api/verdicts — items shown as open by default",
    ar: "تعذّر جلب /api/verdicts — تُعرض العناصر كمفتوحة افتراضًا",
  },
  "stats.planProgress": { en: "Plans & tasks progress: {done}/{total} ({pct}%)", ar: "تنفيذ الخطط والمهام: {done}/{total} ({pct}%)" },
  "stats.bugProgress": { en: "Discovered bugs fixed: {done}/{total} ({pct}%)", ar: "إصلاح الأخطاء المكتشفة: {done}/{total} ({pct}%)" },

  // ===== plans card =====
  "plans.emptyUpcoming": {
    en: "No upcoming plans — defer one with the ☾ button or with <code style=\"color:var(--gold);font-family:'Cascadia Code',monospace\">-(upcoming) #N</code> on one of its steps.",
    ar: "لا خطط قادمة — أجّل خطة بزر ☾ أو بـ<code style=\"color:var(--gold);font-family:'Cascadia Code',monospace\">-(upcoming) #N</code> على إحدى خطواتها.",
  },
  "plans.empty": {
    en: "No active plans. Send <code style=\"color:var(--gold);font-family:'Cascadia Code',monospace\">-(doc:plan) name</code> to start one.",
    ar: "لا توجد خطط نشطة. أرسل <code style=\"color:var(--gold);font-family:'Cascadia Code',monospace\">-(doc:plan) name</code> لبدء واحدة.",
  },
  "plans.promote": { en: "Promote to current plans", ar: "ترقية إلى الخطط الحالية" },
  "plans.completeNoDefer": { en: "Plan complete — only incomplete plans can be deferred", ar: "الخطة مكتملة — التأجيل للخطط غير المكتملة فقط" },
  "plans.stepUpcoming": { en: "Upcoming step — deferred with -(upcoming) #N; promote with -(todo) #N", ar: "خطوة قادمة — مؤجَّلة بـ-(upcoming) #N؛ رقِّها بـ-(todo) #N" },
  "plans.defer": { en: "Defer to upcoming (doesn't block releases)", ar: "تأجيل إلى القادمة (لا توقف الإصدار)" },
  "plans.hideTitle": { en: "Hide from the dashboard (files remain)", ar: "إخفاء من الداشبورد (الملفات تبقى)" },
  "plans.hideCompleted": { en: "◂ Hide {n} completed plans", ar: "◂ إخفاء {n} خطة مكتملة" },
  "plans.showCompleted": { en: "▾ Show {n} completed plans", ar: "▾ إظهار {n} خطة مكتملة" },
  "plans.toggleFail": { en: "Failed to toggle the plan's state", ar: "فشل تبديل حالة الخطة" },
  "plans.hideConfirm": {
    en: "Hide plan \"{title}\" from the dashboard?\nThe files (.md/.html) remain — restore it by re-sending -(doc:plan) with the same name.",
    ar: "إخفاء الخطة \"{title}\" من الداشبورد؟\nالملفات (.md/.html) تبقى — يمكن استعادتها بإعادة إرسال -(doc:plan) بنفس الاسم.",
  },
  "plans.hideOk": { en: "Hide plan", ar: "أخفِ الخطة" },
  "plans.hideFail": { en: "Hide failed", ar: "فشل الإخفاء" },

  // ===== server control =====
  "srv.stop": { en: "Stop server", ar: "إيقاف السيرفر" },
  "srv.stopTitle": { en: "Stop the server (auto-restarts under bun --watch)", ar: "إيقاف السيرفر (يعود تلقائياً مع bun --watch)" },
  "srv.stopConfirm": {
    en: "Stop the server?\nIf it runs under `bun --watch` it restarts automatically; otherwise you'll need to start it manually.",
    ar: "إيقاف السيرفر؟\nإذا كان مُشغَّلاً بـ`bun --watch` فسيعود تلقائياً، وإلا ستحتاج تشغيله يدوياً.",
  },
  "srv.stopOk": { en: "Stop it", ar: "أوقف السيرفر" },
  "srv.stopping": { en: "Stopping...", ar: "...جاري الإيقاف" },

  // ===== changes / file story / diff =====
  "changes.empty": { en: "No edits yet", ar: "لا توجد تعديلات بعد" },
  "changes.archivedTitle": { en: "Content stripped by retention", ar: "المحتوى مُجرَّد بعد retention" },
  "changes.storyTitle": { en: "File story", ar: "قصة الملف" },
  "changes.loadFail": { en: "Failed to load changes: {msg}", ar: "فشل تحميل التغييرات: {msg}" },
  "story.noTags": { en: "No tags linked to this file yet", ar: "لا تاقات مرتبطة بهذا الملف بعد" },
  "story.noEvents": { en: "No recorded edits", ar: "لا تعديلات مسجلة" },
  "story.tags": { en: "Tags ({n})", ar: "التاقات ({n})" },
  "story.events": { en: "Edits ({n})", ar: "التعديلات ({n})" },
  "story.loadFail": { en: "Failed to load the file story: {msg}", ar: "فشل تحميل قصة الملف: {msg}" },
  "diff.none": { en: "No difference", ar: "لا فرق" },

  // ===== sidebar =====
  "side.vulnDanger": { en: "Has libraries with known vulnerabilities", ar: "يحتوي مكتبات ذات ثغرات أمنية" },
  "side.vulnWarn": { en: "Has outdated libraries", ar: "يحتوي مكتبات غير محدثة" },
  "side.vulnSafe": { en: "All libraries clean and up to date", ar: "كل المكتبات سليمة ومحدثة" },
  "side.liveTitle": { en: "Claude Code session running · PID {pids}", ar: "جلسة Claude Code شغّالة · PID {pids}" },
  "side.liveShort": { en: "Session running · PID {pids}", ar: "جلسة شغّالة · PID {pids}" },
  "side.exportTitle": { en: "Export the project's full log (JSON file) to move it to another machine", ar: "تصدير سجل المشروع كاملًا (ملف JSON) لنقله إلى جهاز آخر" },
  "side.renameTitle": { en: "Rename project", ar: "إعادة تسمية المشروع" },
  "side.deleteTitle": { en: "Delete project", ar: "حذف المشروع" },
  "side.empty": {
    en: "No projects yet<br>Start working in any project and it appears here automatically",
    ar: "لا توجد مشاريع بعد<br>ابدأ العمل في أي مشروع وسيظهر هنا تلقائياً",
  },
  "side.active": { en: "Active (last 7 days)", ar: "نشطة (آخر 7 أيام)" },
  "side.activeEmpty": { en: "No active projects", ar: "لا توجد مشاريع نشطة" },
  "side.other": { en: "Other projects", ar: "باقي المشاريع" },
  "side.otherEmpty": { en: "None", ar: "لا يوجد" },

  // ===== maintenance / import =====
  "maint.tombstones": { en: "🪦 Projects missing from disk 30+ days ({n})", ar: "🪦 مشاريع مفقودة من القرص 30+ يومًا ({n})" },
  "maint.import": { en: "⤒ Import a project log (JSON export file)", ar: "⤒ استيراد سجل مشروع (ملف تصدير JSON)" },
  "maint.tombConfirm": {
    en: "Permanently delete projects whose folder has been gone from disk for 30+ days, with all their data (tags/events/plans)?",
    ar: "حذف المشاريع التي اختفى مجلدها من القرص منذ 30+ يومًا نهائيًا بكل بياناتها (تاقات/أحداث/خطط)؟",
  },
  "maint.sweepFail": { en: "Sweep failed", ar: "فشل الكنس" },
  "maint.removed": { en: "Removed: {list}", ar: "حُذفت: {list}" },
  "maint.nothing": { en: "Nothing eligible for deletion (folders returned or markers are recent)", ar: "لا شيء مؤهلًا للحذف (المجلدات عادت أو العلامات حديثة)" },
  "imp.badJson": { en: "The file is not valid JSON", ar: "الملف ليس JSON صالحًا" },
  "imp.wrongKind": {
    en: "This is not a DevLog export file — export it with the ⤓ button next to the project name on the other machine.",
    ar: "هذا ليس ملف تصدير DevLog — صدّره من زر ⤓ بجانب اسم المشروع على الجهاز الآخر.",
  },
  "imp.counts": { en: "{tags} tags · {events} events · {plans} plans", ar: "{tags} تاق · {events} حدث · {plans} خطة" },
  "imp.modeMerge": {
    en: "The project exists here: it will merge into its log (duplicates skipped, imported #N numbers shifted above your current ones)",
    ar: "المشروع موجود هنا: سيُدمج في سجله (تخطّي المكرر، وإزاحة أرقام #N المستوردة فوق أرقامك الحالية)",
  },
  "imp.modeNew": { en: "The project doesn't exist here: it will be registered fresh with its numbers as-is", ar: "المشروع غير موجود هنا: سيُسجَّل جديدًا بأرقامه كما هي" },
  "imp.confirm": {
    en: "Import the log of «{project}» ({counts})?\n{mode}.\nA backup of the data files is taken before writing.",
    ar: "استيراد سجل «{project}» ({counts})؟\n{mode}.\nتُؤخذ نسخة احتياطية من ملفات البيانات قبل الكتابة.",
  },
  "imp.ok": { en: "Import", ar: "استورد" },
  "imp.fail": { en: "Import failed", ar: "فشل الاستيراد" },
  "imp.done": {
    en: "Import complete: +{tags} tags, +{events} events, +{plans} plans (+{steps} steps), archive +{archive} lines.\nSkipped (already present): {skipped} · renumbered: {renumbered}.",
    ar: "اكتمل الاستيراد: +{tags} تاق، +{events} حدث، +{plans} خطة (+{steps} خطوة)، أرشيف +{archive} سطر.\nمتخطّى (موجود مسبقًا): {skipped} · معاد ترقيمه: {renumbered}.",
  },
  "imp.title": { en: "Project import", ar: "استيراد المشروع" },

  // ===== rename / delete project =====
  "ren.prompt": {
    en: "Rename project \"{name}\"\nIts on-disk folder is renamed too (if present), and tags + memory move with it.",
    ar: "إعادة تسمية المشروع \"{name}\"\nسيُعاد تسمية مجلده على القرص أيضاً (إن وُجد)، وتنتقل التاقات والميموري.",
  },
  "ren.title": { en: "Rename", ar: "إعادة تسمية" },
  "ren.ok": { en: "Rename", ar: "أعد التسمية" },
  "ren.fail": { en: "Rename failed", ar: "تعذّرت إعادة التسمية" },
  "ren.movedFolder": { en: "folder → {path}", ar: "المجلد → {path}" },
  "ren.movedMem": { en: "moved {n} memory cards", ar: "نُقل {n} بطاقة ميموري" },
  "ren.skippedMem": { en: "skipped {n} pre-existing cards", ar: "تُخطّي {n} بطاقة موجودة مسبقاً" },
  "ren.doneSkipped": {
    en: "Renamed.\nSkipped {n} memory cards because a counterpart exists at the destination (nothing overwritten).",
    ar: "تمّت إعادة التسمية.\nتُخطّي {n} بطاقة ميموري لوجود نظيرة لها في الوجهة (لم تُطمَس).",
  },
  "del.confirm": { en: "Delete project \"{name}\"?\nAll its tags and events will be deleted.", ar: "حذف المشروع \"{name}\"؟\nسيتم حذف جميع التاقات والأحداث المرتبطة به." },
  "del.ok": { en: "Delete project", ar: "احذف المشروع" },

  // ===== header =====
  "about.hover": { en: "Hover to view details", ar: "مرر الماوس لعرض التفاصيل" },
  "about.missing": { en: "No about — send -(about) to add it", ar: "لا يوجد about — أرسل -(about) لإضافته" },
  "git.noRemote": { en: "No git remote configured", ar: "لا يوجد git remote مضبوط" },
  "hdr.next": { en: "Next ⏳", ar: "القادم ⏳" },
  "hdr.nextTitle": { en: "Preview the next release before shipping it — generated live, writes nothing", ar: "معاينة الإصدار القادم قبل إصداره — تُولَّد حيًّا ولا تكتب شيئًا" },
  "hdr.clientReport": { en: "Client report 🧾", ar: "تقرير العميل 🧾" },
  "hdr.clientReportTitle": {
    en: "Client-facing status report: capabilities, latest release and reliability — counts only, no internals or security details",
    ar: "تقرير حالة موجّه للعميل: قدرات النظام وآخر إصدار والاعتمادية — أعداد فقط بلا تفاصيل داخلية أو أمنية",
  },
  "hdr.modelStats": { en: "Model stats 🤖", ar: "أداء النماذج 🤖" },
  "hdr.modelStatsTitle": {
    en: "Model performance from your actual log: who opened reports and who fixed them, whose fixes regressed, and who shipped a fix without a test",
    ar: "أداء النماذج من سجلك الفعلي: من فتح البلاغات ومن أصلحها، إصلاحات من انتكست، ومن شحن إصلاحًا بلا اختبار",
  },
  "hdr.sessionsTitle": { en: "Active Claude sessions", ar: "جلسات Claude النشطة" },
  "statsPop.title": { en: "Stats", ar: "إحصائيات" },
  "statsPop.files": { en: "files", ar: "ملف" },
  "statsPop.libs": { en: "libraries", ar: "مكتبة" },
  "statsPop.dirs": { en: "folders", ar: "مجلد" },
  "statsPop.tags": { en: "tags", ar: "تاق" },
  "statsPop.exts": { en: "File types", ar: "أنواع الملفات" },
  "statsPop.open": { en: "Click to open the project map", ar: "اضغط لفتح خريطة المشروع" },
  "statsPop.tabTrends": { en: "Trends", ar: "الاتجاهات" },
  "statsPop.trendOpened": { en: "opened", ar: "فُتح" },
  "statsPop.trendClosed": { en: "closed", ar: "أُغلق" },
  "statsPop.trendReleased": { en: "releases", ar: "إصدارات" },
  "statsPop.trendsEmpty": { en: "Not enough history to chart yet", ar: "لا يوجد تاريخ كافٍ للرسم بعد" },

  // ===== libraries =====
  "lib.openPage": { en: "Open the library's page", ar: "فتح صفحة المكتبة" },
  "lib.openVerify": { en: "Open the library's page to verify manually", ar: "فتح صفحة المكتبة للتأكد يدوياً" },
  "lib.vulnCount": { en: "{n} vulnerabilities", ar: "{n} ثغرة" },
  "deps.openTitle": { en: "Click to open the libraries page — purpose, description and status", ar: "اضغط لفتح صفحة المكتبات — الغرض والوصف والحالة" },
  "deps.empty": { en: "No libraries", ar: "لا توجد مكتبات" },
  "deps.freshTitle": { en: "The fix was released {d} days ago — wait before upgrading", ar: "الفيكس صدر قبل {d} يوم — انتظر قبل الترقية" },
  "deps.freshLabel": { en: "⏳ {d} days ago", ar: "⏳ منذ {d} يوم" },

  // ===== context menu / tree =====
  "ctx.openFile": { en: "Open in a new window", ar: "فتح في نافذة جديدة" },
  "ctx.ignoreDir": { en: "Ignore this folder", ar: "تجاهل هذا المجلد" },
  "ctx.ignoreFile": { en: "Ignore this file", ar: "تجاهل هذا الملف" },

  // ===== injection panel =====
  "inj.modalTitle": { en: "Injection", ar: "الحقن" },
  "topbar.standards": { en: "Standards", ar: "المعايير" },
  "inj.subSessionStart": { en: "Inject the project summary at session start", ar: "حقن ملخص المشروع عند بدء الجلسة" },
  "inj.subUserPrompt": { en: "Automatic reminder of remaining tasks for Claude Code", ar: "تذكير تلقائي بالمهام المتبقية لكلود كود" },
  "inj.subPreRead": { en: "Inject the file's memory before it is read", ar: "حقن ذاكرة الملف قبل قراءته" },
  "inj.outdatedLabel": { en: "Outdated libraries", ar: "مكتبات منتهية" },
  "inj.outdatedSub": { en: "Alert Claude to every outdated library at session start", ar: "تنبيه كلود بكل المكتبات القديمة عند بدء الجلسة" },
  "inj.descLabel": { en: "Description nudge", ar: "تذكير الوصف" },
  "inj.descSub": {
    en: "Nudge Claude to add a missing desc/about. Works even with session-start injection off",
    ar: "تنبيه كلود لإضافة desc/about الناقصَين. يعمل حتى مع إطفاء «حقن البداية»",
  },
  "inj.upcomingLabel": { en: "Upcoming line", ar: "سطر القادمة" },
  "inj.upcomingSub": {
    en: "Show deferred (upcoming) items in the session-start summary — informational only, blocks nothing",
    ar: "عرض العناصر المؤجلة (قادمة) في ملخص بداية الجلسة — للعلم فقط، لا توقف شيئًا",
  },
  "inj.claudeMdSub": { en: "Write the project summary into CLAUDE.md (under development)", ar: "كتابة ملخص المشروع في ملف CLAUDE.md (قيد التطوير)" },
  "inj.contextMdSub": { en: "Write extra context into a file (under development)", ar: "كتابة سياق إضافي في ملف (قيد التطوير)" },
  "inj.enforceLabel": { en: "Standards enforcement", ar: "إجبار المعايير" },
  "inj.enforceSub": {
    en: "Blocks writing code until Claude pulls the project's standards. Turn it off for already-compliant projects (manual pull stays available).",
    ar: "يمنع كتابة الكود حتى يسحب كلود معايير المشروع. أوقفه للمشاريع المطبَّقة أصلاً (السحب اليدوي يبقى متاحاً).",
  },
  "inj.overrideNote": { en: "⚙️ This project has overrides that take precedence over global", ar: "⚙️ هذا المشروع له إعدادات خاصة تطغى على العام" },
  "inj.clearOverride": { en: "Remove override", ar: "إزالة التخصيص" },
  "inj.wip": { en: "Under development", ar: "قيد التطوير" },
  "inj.histEmpty": { en: "No recorded injections for this project", ar: "لا توجد حقنات مسجلة لهذا المشروع" },
  "inj.chars": { en: "{n}ch", ar: "{n}ح" },
  "inj.view": { en: "View", ar: "عرض" },
  "inj.tabGlobal": { en: "Global settings", ar: "الإعدادات العامة" },
  "inj.tabProject": { en: "Project-specific", ar: "خاص بالمشروع" },
  "inj.groupDynamic": { en: "Dynamic injection (for Claude)", ar: "حقن ديناميكي (لـ Claude)" },
  "inj.groupEnforce": { en: "Enforcement", ar: "الإجبار" },
  "inj.enforceNote": {
    en: "Standards enforcement is set per project — open the «Project-specific» tab.",
    ar: "إجبار المعايير يُضبط لكل مشروع — افتح تبويب «خاص بالمشروع».",
  },
  "inj.groupStatic": { en: "Static injection (project files)", ar: "حقن ثابت (ملفات المشروع)" },
  "inj.preview": { en: "Live preview ({n} chars)", ar: "معاينة حية ({n} حرف)" },
  "inj.previewEmpty": { en: "— nothing would be injected right now —", ar: "— لا يوجد محتوى يُحقن حالياً —" },
  "inj.previewMeta": {
    en: "This is what would be injected right now if a new session started in this project.",
    ar: "هذا ما سيُحقن الآن لو بدأت جلسة جديدة في هذا المشروع.",
  },
  "inj.history": { en: "History ({n})", ar: "السجل التاريخي ({n})" },
  "inj.docTitle": { en: "Injection {type}", ar: "حقنة {type}" },

  // ===== standards viewer =====
  "std.loadFail": { en: "Failed to load standards", ar: "فشل تحميل المعايير" },
  "std.emptyCatalog": { en: "Catalog is empty — add .md files under ~/.claude/standards/", ar: "الكتالوج فارغ — أضف ملفات .md في ~/.claude/standards/" },
  "std.check": { en: "check", ar: "فحص" },
  "std.guide": { en: "guide", ar: "نصيحة" },
  "std.summary": { en: "{cats} categories · {rules} rules · {enforced} blocking checkers", ar: "{cats} تصنيف · {rules} قاعدة · {enforced} فاحص يحجب" },
  "std.scopeProject": { en: "project", ar: "خاص بالمشروع" },
  "std.scopeGlobal": { en: "global", ar: "عام" },
  "std.enforcedTitle": { en: "actively blocks", ar: "يحجب فعلاً" },
  "std.rich": { en: "📄 Extended reference standard — open the file for its details", ar: "📄 معيار مرجعي موسّع — افتح الملف لعرض تفاصيله" },
  "std.noRules": { en: "No rules yet", ar: "لا قواعد بعد" },
  "std.acks": { en: "This project's acks", ar: "مؤكَّدات هذا المشروع (ack)" },

  // ===== updates badge =====
  "upd.badgeTitle": { en: "Tool updates available", ar: "تحديثات الأدوات متاحة" },
  "upd.one": { en: "update", ar: "تحديث" },
  "upd.many": { en: "{n} updates", ar: "{n} تحديثات" },
  "upd.badge": { en: "🔄 {what} available", ar: "🔄 {what} متاحة" },
  "upd.clickDetails": { en: "(click for details)", ar: "(انقر للتفاصيل)" },
  "upd.howPlugin": { en: "\n\nTo update inside Claude Code:\n/plugin marketplace update", ar: "\n\nللتحديث داخل Claude Code:\n/plugin marketplace update" },
  "upd.howGit": { en: "\n\nTo update:\ngit pull then restart the server", ar: "\n\nللتحديث:\ngit pull ثم أعد تشغيل الخادم" },
  "upd.title": { en: "Updates available", ar: "تحديثات متاحة" },
  "upd.body": { en: "Updates available:\n\n{lines}{how}", ar: "تحديثات متاحة:\n\n{lines}{how}" },

  // ===== memory & docs card =====
  "mem.user": { en: "user", ar: "مستخدم" },
  "mem.feedback": { en: "feedback", ar: "ملاحظة" },
  "mem.project": { en: "project", ar: "مشروع" },
  "mem.reference": { en: "reference", ar: "مرجع" },
  "doc.report": { en: "report", ar: "تقرير" },
  "doc.analysis": { en: "analysis", ar: "تحليل" },
  "doc.plan": { en: "plan", ar: "خطة" },
  "doc.comparison": { en: "comparison", ar: "مقارنة" },
  "doc.readme": { en: "readme", ar: "readme" },
  "doc.study": { en: "study", ar: "دراسة" },
  "doc.updatedAt": { en: " — updated {date}", ar: " — آخر تحديث {date}" },
  "doc.noPreview": { en: "Preview unavailable — click the row to open the full page", ar: "المعاينة غير متاحة — اضغط سطر الوثيقة لفتح صفحتها الكاملة" },
  "doc.openFull": { en: "Click to open the full page", ar: "اضغط لفتح الصفحة الكاملة" },
  "doc.memSection": { en: "Memory", ar: "ذاكرة" },
  "doc.docSection": { en: "Docs", ar: "توثيق" },

  // ===== dashboard.html static =====
  "welcome.text": {
    en: "An automatic dev log for all your projects<br>Tracks changes, libraries and security issues<br>Pick a project from the list or just start working",
    ar: "سجل تطوير تلقائي لكل مشاريعك<br>يتتبع التغييرات والمكتبات والمشاكل الأمنية<br>اختر مشروع من القائمة أو ابدأ العمل",
  },

  // ===== deps explainer page =====
  "depsPage.back": { en: "← Dashboard", ar: "→ الداشبورد" },
  "depsPage.h1": { en: "Libraries of", ar: "مكتبات" },
  "depsPage.searchPh": { en: "Search by library name or purpose…", ar: "ابحث باسم المكتبة أو الغرض…" },
  "depsPage.docTitle": { en: "Project libraries", ar: "مكتبات المشروع" },
  "depsPage.title": { en: "Libraries of {project}", ar: "مكتبات {project}" },
  "depsPage.noProject": {
    en: "No project specified — open this page from the dependencies button in the dashboard.",
    ar: "لا مشروع محدد — افتح الصفحة من زر dependencies في الداشبورد.",
  },
  "depsPage.loadFail": { en: "Failed to load libraries: {msg}", ar: "تعذّر تحميل المكتبات: {msg}" },
  "depsPage.unknownProject": { en: "Unknown project.", ar: "مشروع غير معروف." },
  "depsPage.noLibs": { en: "No known libraries for the project yet (they appear after the first scan).", ar: "لا مكتبات معروفة للمشروع بعد (تظهر بعد أول فحص)." },
  "depsPage.coverageFull": { en: "Full coverage — <b>{n}</b> libraries with a recorded purpose", ar: "التغطية كاملة — <b>{n}</b> مكتبة بغرض مسجَّل" },
  "depsPage.coverageMissing": { en: "<b>{missing}</b> of {total} without a recorded purpose", ar: "<b>{missing}</b> من {total} بلا غرض مسجَّل" },
  "depsPage.noPurpose": {
    en: "No recorded purpose — ask Claude: <span dir=\"ltr\">-(ask:deps)</span>",
    ar: "بلا غرض مسجَّل — اطلب من كلود: <span dir=\"ltr\">-(ask:deps)</span>",
  },
  "depsPage.latestTitle": { en: "Latest version", ar: "النسخة الأحدث" },

  // ===== stack map page =====
  "stack.back": { en: "← Home", ar: "← الرئيسية" },
  "stack.searchPh": { en: "Search by name…", ar: "بحث بالاسم…" },
  "stack.searchTitle": { en: "Highlights matches and jumps to them — Enter focuses the best one", ar: "يوهج المطابقات ويقفز إليها — Enter يركّز على الأفضل" },
  "stack.regen": { en: "Regenerate map", ar: "تحديث الخريطة" },
  "stack.regenTitle": { en: "Regenerate DEVLOG_STACK.md from the current code", ar: "إعادة توليد DEVLOG_STACK.md من الكود الحالي" },
  "stack.layoutTitle": { en: "Layout mode", ar: "نوع الترتيب" },
  "stack.layoutRadial": { en: "Radial (default)", ar: "شعاعي (افتراضي)" },
  "stack.layoutForce": { en: "Force (clusters)", ar: "قوى (عناقيد)" },
  "stack.layoutLayered": { en: "Layered (call graph)", ar: "طبقي (call graph)" },
  "stack.activityTitle": { en: "Highlight recently active files", ar: "إبراز الملفات النشطة مؤخراً" },
  "stack.activity": { en: "Activity: {state}", ar: "نشاط: {state}" },
  "stack.activityOn": { en: "Activity: ON", ar: "نشاط: ON" },
  "stack.relayout": { en: "Auto re-layout", ar: "إعادة ترتيب تلقائي" },
  "stack.railLabel": { en: "Tools & isolated", ar: "أدوات ومعزولات" },
  "stack.lines": { en: "{n} lines", ar: "{n} سطر" },
  "stack.tipMeta": { en: "{lines} lines · importance {imp}/3 · {group}", ar: "{lines} سطر · أهمية {imp}/3 · {group}" },
  "stack.unreached": { en: "Not reachable from the entry points", ar: "غير موصول من نقاط الدخول" },
  "stack.hint": {
    en: "Click: isolate neighbors · double-click: open in VS Code · drag: pin position",
    ar: "اضغط: عزل الجوار · اضغط مرتين: فتح في VS Code · اسحب: تثبيت المكان",
  },
  "stack.lastScan": { en: "Last scan: {when}", ar: "آخر مسح: {when}" },
  "stack.generating": { en: "Generating…", ar: "يولّد…" },
  "stack.regenFail": { en: "Regeneration failed", ar: "فشل التحديث" },
  "stack.noProject": { en: "No project specified in ?project=", ar: "لا يوجد مشروع محدد في ?project=" },
  "stack.noStack": { en: "STACK.md not found — run a project scan first", ar: "STACK.md غير موجود — شغّل مسح المشروع أولاً" },

  // ===== features tour page =====
  "feat.docTitle": { en: "DevLog — feature tour", ar: "DevLog — جولة في المميزات" },
  "feat.navBasics": { en: "Basics", ar: "الأساسيات" },
  "feat.navAdvanced": { en: "Advanced", ar: "المتقدّمة" },
  "feat.navApi": { en: "API", ar: "واجهة API" },
  "feat.navDash": { en: "Dashboard", ar: "الداش بورد" },
  "feat.heroTag": {
    en: "An automatic dev log for Claude Code projects. Claude writes short tags in its replies, and the Stop hook captures them to feed a local dashboard — polluting no repository and consuming none of Claude's context.",
    ar: "سجلّ تطوير تلقائي لمشاريع Claude Code. كلود يكتب تاقات قصيرة في ردوده، وخطّاف Stop يلتقطها ويغذّي داش بورد محلّي — بلا تلويث أي مستودع ولا استهلاك سياق كلود.",
  },
  "feat.badgeZeroDeps": { en: "Zero runtime dependencies", ar: "صفر تبعيات runtime" },
  "feat.badgeLocal": { en: "Local 127.0.0.1 only", ar: "محلّي 127.0.0.1 فقط" },
  "feat.badgeNoTracking": { en: "No tracking", ar: "بلا تتبّع" },
  "feat.shotAlt": { en: "DevLog interface", ar: "واجهة DevLog" },
  "feat.shotCap": {
    en: "The main dashboard — every project's activity, plans, releases and security notes in one place.",
    ar: "الداش بورد الرئيسي — نشاط كل مشروع، الخطط، الإصدارات، والملاحظات الأمنية في مكان واحد.",
  },
  "feat.secBasics": { en: "Basics", ar: "الأساسيات" },
  "feat.leadBasics": { en: "What you see at first glance", ar: "ما تراه من أول نظرة" },
  "feat.secAdvanced": { en: "Advanced features", ar: "المميزات المتقدّمة" },
  "feat.leadAdvanced": { en: "The \"hidden\" capabilities — present and working, behind the API", ar: "القدرات «المخفية» — موجودة وشغّالة، خلف واجهة API" },
  "feat.secApi": { en: "API", ar: "واجهة API" },
  "feat.leadApi": { en: "All of it inside one Bun server on port 7777", ar: "كل ذلك داخل سيرفر Bun واحد على المنفذ 7777" },
  "feat.pillCore": { en: "Core", ar: "أساسي" },
  "feat.pillHidden": { en: "Hidden", ar: "مخفي" },
  "feat.dChat": { en: "…added the auth function and closed the vulnerability.", ar: "…أضفت دالة المصادقة وأغلقت الثغرة." },
  "feat.captureH3": { en: "Automatic tag capture", ar: "التقاط التاقات تلقائياً" },
  "feat.captureP": {
    en: "Claude ends its reply with <code>-(tag) content</code> markers. The Stop hook scans the reply, captures them and sends them to the dashboard — built, bug fix, todo, security note, architectural decision… with no manual file.",
    ar: "كلود يُنهي ردّه بعلامات <code>-(tag) محتوى</code>. خطّاف Stop يمسح الرد، يلتقطها، ويرسلها للداش بورد — مبنيّ، إصلاح خطأ، todo، ملاحظة أمنية، قرار معماري… بلا أي ملف يدوي.",
  },
  "feat.captureApi": { en: "Captured by <b>parse-tags.js</b> ← <b>POST /api/tags</b>", ar: "يلتقطها <b>parse-tags.js</b> ← <b>POST /api/tags</b>" },
  "feat.dPlanTitle": { en: "Plan: login feature", ar: "خطة: ميزة تسجيل الدخول" },
  "feat.dPlanS1": { en: "Login page", ar: "صفحة الدخول" },
  "feat.dPlanS2": { en: "Form validation", ar: "التحقق من النموذج" },
  "feat.dPlanS4": { en: "JWT issuance", ar: "إصدار JWT" },
  "feat.dPlanClose": { en: "2 / 4 — closed from chat with", ar: "2 / 4 — تُغلَق من الشات بـ" },
  "feat.plansH3": { en: "Trackable plans", ar: "خطط قابلة للتتبّع" },
  "feat.plansP": {
    en: "A <code>-(doc:plan)</code> tag generates a markdown + html document and registers every <code>[ ]</code> as a step. Boxes flip and bars move across sessions — all from the conversation, with #N completion tracking.",
    ar: "تاق <code>-(doc:plan)</code> يولّد مستند markdown + html ويسجّل كل <code>[ ]</code> كخطوة. الخانات تنقلب والأشرطة تتحرّك عبر الجلسات — كله من المحادثة، مع تتبّع الإكمال بالأرقام <code>#N</code>.",
  },
  "feat.plansApi": { en: "Written by <b>doc-store.ts</b> under <b>&lt;project&gt;/.devlog/docs/</b>", ar: "يكتبها <b>doc-store.ts</b> تحت <b>&lt;project&gt;/.devlog/docs/</b>" },
  "feat.dRejected": { en: "⛔ Rejected — open items:", ar: "⛔ مرفوض — عناصر مفتوحة:" },
  "feat.dRejTodo": { en: "todo #7 — API docs", ar: "todo #7 — توثيق الـAPI" },
  "feat.dRejBug": { en: "bug #12 — memory leak", ar: "bug #12 — تسرّب ذاكرة" },
  "feat.dRejClose": { en: "Close everything before releasing.", ar: "أغلِق الكل قبل الإصدار." },
  "feat.closureH3": { en: "Closure enforcement + release guard", ar: "إلزام الإغلاق + حارس الإصدار" },
  "feat.closureP": {
    en: "The Stop hook matches built work against open items and reminds you to close them. The PreToolUse hook intercepts release commands (<code>gh release</code>, <code>git tag -a</code>, <code>npm publish</code>…) and rejects them while open work remains.",
    ar: "خطّاف Stop يطابق المبنيّ مع العناصر المفتوحة ويذكّر بإغلاقها. وخطّاف PreToolUse يعترض أوامر الإصدار (<code>gh release</code>، <code>git tag -a</code>، <code>npm publish</code>…) ويرفضها ما دام فيه عمل مفتوح.",
  },
  "feat.dLibTitle": { en: "Library version scan", ar: "فحص إصدارات المكتبات" },
  "feat.dLibFresh": { en: "⏳ &lt; 7 days", ar: "⏳ &lt; 7 أيام" },
  "feat.libscanH3": { en: "Library version scanning", ar: "فحص إصدارات المكتبات" },
  "feat.libscanP": {
    en: "The \"Security scan\" button compares every dependency against its official registry and highlights the stale ones — latest version and its date, with a ⏳ warning for versions fresher than 7 days. Fully built-in: no external service, no API key.",
    ar: "زرّ «فحص أمني» يقارن كل تبعية بسجلّ نظامها الرسمي ويُبرز المتأخّرة — الإصدار الأحدث وتاريخه، مع تحذير ⏳ للإصدارات الأطرى من 7 أيام. مدمج بالكامل: بلا خدمة خارجية ولا مفتاح API.",
  },
  "feat.analysisH3": { en: "Static code analysis engine", ar: "محرّك تحليل كود ساكن" },
  "feat.analysisP": {
    en: "An analyzer (tokenizer + multi-language symbol extractor) maps HTTP routes, the <b>function call graph</b>, module dependency graph, threads, IPC messages, data types and security-sensitive patterns — with no external language grammars.",
    ar: "مُحلِّل (tokenizer + مستخرِج رموز متعدّد اللغات) يرسم مسارات HTTP، <b>رسم استدعاء الدوال</b> (call graph)، رسم اعتماد الوحدات، الخيوط، رسائل IPC، أنواع البيانات، وأنماطاً حسّاسة أمنياً — دون قواعد لغة خارجية.",
  },
  "feat.dKill": { en: "kill", ar: "إنهاء" },
  "feat.procsH3": { en: "Live process monitoring + kill", ar: "مراقبة العمليات الحيّة + إنهاؤها" },
  "feat.procsP": {
    en: "Shows active Claude Code sessions and builds the <b>spawned process tree</b> on Windows — so you spot runaway processes and kill any PID straight from the dashboard.",
    ar: "يعرض جلسات Claude Code النشطة ويبني <b>شجرة العمليات المتفرّعة</b> على ويندوز — فتشوف العمليات الجامحة وتُنهي أي PID مباشرة من الداش بورد.",
  },
  "feat.dDiffTitle": { en: "auth.ts — edit #34", ar: "auth.ts — تعديل #34" },
  "feat.dDiffScope": { en: "per edit · per file · per session", ar: "لكل تعديل · لكل ملف · لكل جلسة" },
  "feat.diffH3": { en: "File change tracking with diff", ar: "تتبّع تغييرات الملفات مع diff" },
  "feat.diffP": {
    en: "Stores <code>old_string</code> / <code>new_string</code> for every edit Claude makes and renders the <b>diff in-house</b> — at the level of a single edit, a file, or a whole session.",
    ar: "يخزّن <code>old_string</code> / <code>new_string</code> لكل تعديل يجريه كلود ويعرض <b>diff داخلياً</b> — على مستوى التعديل الواحد، أو الملف، أو الجلسة كاملة.",
  },
  "feat.stackH3": { en: "Cross-project stack map", ar: "خريطة Stack عبر المشاريع" },
  "feat.stackP": {
    en: "A bird's-eye view of every project's languages, frameworks and libraries on one page, with a saveable layout — see your technologies from above across the whole portfolio.",
    ar: "نظرة شاملة على لغات وأُطر ومكتبات كل مشاريعك في صفحة واحدة، مع تخطيط قابل للحفظ — لترى تقنياتك من علٍ عبر المحفظة كلها.",
  },
  "feat.dInjPreview": { en: "↓ injection preview", ar: "↓ معاينة الحقن" },
  "feat.treeH3": { en: "Tree browser · export · injection preview", ar: "متصفّح الشجرة · التصدير · معاينة الحقن" },
  "feat.treeP": {
    en: "Browse the project tree inside the dashboard, export a project (or all of them) to portable JSON, and preview the SessionStart context block <b>exactly</b> before it's injected — with the past injection log.",
    ar: "تصفّح شجرة المشروع داخل الداش بورد، صدّر مشروعاً (أو الكل) إلى JSON محمول، وعايِن كتلة سياق SessionStart <b>بالضبط</b> قبل حقنها — مع سجلّ الحقن السابق.",
  },
  "feat.dWsLive": { en: "WebSocket connected — live updates", ar: "WebSocket متّصل — تحديث حيّ" },
  "feat.dWsNow": { en: "now · built · scanner.ts", ar: "الآن · built · scanner.ts" },
  "feat.dWsRet": { en: "Retention policy:", ar: "سياسة الاحتفاظ:" },
  "feat.dWsOld": { en: "old events → trimmed", ar: "أحداث قديمة → تُقلَّم" },
  "feat.dWsProtected": { en: "closure-linked items protected", ar: "العناصر المرتبطة بالإغلاق محميّة" },
  "feat.liveH3": { en: "Live updates + retention policy", ar: "تحديث حيّ + سياسة احتفاظ" },
  "feat.liveP": {
    en: "The dashboard subscribes over WebSocket so tags and processes appear instantly with no page refresh. In the background, old events are trimmed by a retention policy that protects closure-linked items.",
    ar: "الداش بورد يشترك عبر WebSocket فتظهر التاقات والعمليات فوراً بلا تحديث للصفحة. وفي الخلفية تُقلَّم الأحداث القديمة وفق سياسة احتفاظ تحمي العناصر المرتبطة بالإغلاق.",
  },
  "feat.thFeature": { en: "Feature", ar: "الميزة" },
  "feat.thEntry": { en: "Entry point", ar: "نقطة الدخول" },
  "feat.thFile": { en: "File", ar: "الملف" },
  "feat.rowAnalysis": { en: "Static code analysis", ar: "تحليل الكود الساكن" },
  "feat.rowProcs": { en: "Process monitoring/kill", ar: "مراقبة/إنهاء العمليات" },
  "feat.rowChanges": { en: "Change tracking + diff", ar: "تتبّع التغييرات + diff" },
  "feat.rowStack": { en: "Stack map", ar: "خريطة Stack" },
  "feat.rowTree": { en: "Tree browser", ar: "متصفّح الشجرة" },
  "feat.rowExport": { en: "Export", ar: "التصدير" },
  "feat.rowInject": { en: "Injection preview", ar: "معاينة الحقن" },
  "feat.rowVuln": { en: "Library scan", ar: "فحص المكتبات" },
  "feat.rowTags": { en: "Tag capture", ar: "التقاط التاقات" },
  "feat.footer": {
    en: "DevLog — all data is local, the server listens on <code>127.0.0.1</code> only, no tracking.<br>For the full reference see the <a href=\"https://github.com/fmaaakcode/devlog#readme\">README</a> and the bundled <code>devlog-protocol</code> skill (the tag protocol).",
    ar: "DevLog — كل البيانات محلّية، السيرفر يستمع على <code>127.0.0.1</code> فقط، بلا تتبّع.<br>للمرجع الكامل راجع <a href=\"https://github.com/fmaaakcode/devlog#readme\">README</a> ومهارة <code>devlog-protocol</code> المرفقة (بروتوكول التاقات).",
  },
};

// ---------------------------------------------------------------------------
// Runtime. All DOM/localStorage access stays inside functions so the module
// can be imported by bun tests (no DOM) to validate DICT.

const hasDom = () => typeof document !== "undefined";

export function getLang() {
  try {
    const v = localStorage.getItem("devlog-lang");
    if (v === "en" || v === "ar") return v;
  } catch { /* storage unavailable (tests / privacy mode) */ }
  if (hasDom() && document.documentElement.dataset.defaultLang === "en") return "en";
  return "ar";
}

let lang = "ar";
let initialized = false;
function ensureLang() {
  if (!initialized) { lang = getLang(); initialized = true; }
  return lang;
}

export function currentLang() { return ensureLang(); }
export function locale() { return ensureLang() === "ar" ? "ar" : "en"; }
export function uiDir() { return ensureLang() === "ar" ? "rtl" : "ltr"; }

export function setLang(next) {
  ensureLang();
  lang = next === "en" ? "en" : "ar";
  try { localStorage.setItem("devlog-lang", lang); } catch { /* best-effort persistence */ }
}

export function toggleLang() { setLang(ensureLang() === "ar" ? "en" : "ar"); }

export function t(key, params) {
  const entry = DICT[key];
  let s = entry ? (entry[ensureLang()] ?? entry.ar ?? entry.en) : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

// Apply the current language to static markup: data-i18n (textContent),
// data-i18n-html (innerHTML — dictionary values are first-party, never user
// data), data-i18n-title (title attr), data-i18n-ph (placeholder), and the
// document direction. Safe to call repeatedly (the language toggle does).
export function applyI18n(root) {
  if (!hasDom()) return;
  const scope = root || document;
  ensureLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = uiDir();
  for (const el of scope.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of scope.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of scope.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of scope.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
}
