// AI 生成声明:本插件代码由 AI 生成,可能存在错误或安全隐患,使用前请 review 并实测。
//
// @choi-p/dsh-tenancy — Client 半(P3)
// 完全沿用 @choi-p/dsh-footer-order 的成熟范式:惰性 CJS factory 经
// window.__ModuleLoader__.load 注册,由宿主注入 react 与 cordis 客户端服务。
//
// 组件(全部数据经同源 /tenancy/* 管理面获取,Caddy/Authelia 链路自动携带身份):
//   1. ShareButton      → conversation.session.header.actions:打开共享对话框;
//   2. OwnerBadge       → conversation.session.header.utilities:owner/模式徽章;
//   3. TenancySettingsCard → settings.plugin.item:whoami + 我的会话共享管理;
//   4. ShareDialog      ← 1/3 复用的固定定位对话框(mode/readers/writers 编辑)。
window.__ModuleLoader__.load({
  id: '@choi-p/dsh-tenancy',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');

    /** Required client services. */
    var inject = ['slots', 'locale'];

    var en = {
      shareLabel: 'Share',
      badgeYou: 'you',
      badgeOwner: 'Owner',
      badgeMode: 'Access',
      modePrivate: 'Private',
      modeTeamRead: 'Team read',
      modeTeamRw: 'Team read/write',
      dialogTitle: 'Session sharing',
      ownerLabel: 'Owner',
      accessLabel: 'Access mode',
      readersLabel: 'Extra readers (comma-separated usernames)',
      writersLabel: 'Extra writers (comma-separated usernames)',
      saveLabel: 'Save',
      closeLabel: 'Close',
      savingStatus: 'Saving…',
      savedStatus: 'Saved.',
      loadFailed: 'Failed to load sharing info.',
      noPermission: 'You do not have permission to edit this session.',
      notShared: 'This session has no sharing record yet.',
      cardTitle: 'Tenancy',
      cardDescription: 'Identity and session sharing for this deployment.',
      whoamiLabel: 'Signed in as',
      sessionsLabel: 'My sessions',
      sessionsEmpty: 'No sharing records yet. Create a session first.',
      unknownUser: '(unknown)',
    };
    var zh = {
      shareLabel: '共享',
      badgeYou: '我',
      badgeOwner: '所有者',
      badgeMode: '权限',
      modePrivate: '私有',
      modeTeamRead: '团队可读',
      modeTeamRw: '团队读写',
      dialogTitle: '会话共享',
      ownerLabel: '所有者',
      accessLabel: '访问级别',
      readersLabel: '额外可读者(逗号分隔用户名)',
      writersLabel: '额外可写者(逗号分隔用户名)',
      saveLabel: '保存',
      closeLabel: '关闭',
      savingStatus: '保存中…',
      savedStatus: '已保存。',
      loadFailed: '共享信息加载失败。',
      noPermission: '你没有编辑此会话共享的权限。',
      notShared: '该会话还没有共享记录。',
      cardTitle: '多租户',
      cardDescription: '本部署的身份与会话共享管理。',
      whoamiLabel: '当前身份',
      sessionsLabel: '我的会话',
      sessionsEmpty: '还没有共享记录;先创建会话吧。',
      unknownUser: '(未知)',
    };

    var MODES = ['private', 'team-read', 'team-rw'];
    /** whoami 缓存(模块级):身份在一次页面生命周期内不变。 */
    var mePromise = null;
    function whoami() {
      if (mePromise === null) {
        mePromise = fetch('/tenancy/whoami', { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
      }
      return mePromise;
    }

    /** 同源 JSON API 小封装;返回 {ok,status,data}。 */
    function api(method, path, body) {
      return fetch(path, {
        method: method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
      }).then((r) => r.json().catch(() => ({})).then((data) => ({ ok: r.ok, status: r.status, data: data })));
    }

    function parseList(text) {
      return String(text ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    }

    /** ── 共享对话框(固定定位遮罩;1/3 复用)────────────────────────────── */
    function ShareDialog(props) {
      var sessionId = props.sessionId;
      var t = props.t;
      var onClose = props.onClose;
      var state = react.useState({ loading: true, failed: false, rec: null, me: null });
      var info = state[0]; var setInfo = state[1];
      var saveState = react.useState({ busy: false, message: '' });
      var save = saveState[0]; var setSave = saveState[1];
      var fieldsState = react.useState({ mode: 'private', readers: '', writers: '' });
      var fields = fieldsState[0]; var setFields = fieldsState[1];

      react.useEffect(function () {
        var alive = true;
        Promise.all([api('GET', '/tenancy/sessions/' + encodeURIComponent(sessionId) + '/acl'), whoami()])
          .then(function (results) {
            if (!alive) return;
            var res = results[0]; var me = results[1];
            if (!res.ok && res.status !== 404) { setInfo({ loading: false, failed: true, rec: null, me: me }); return; }
            var rec = res.ok ? res.data : null;
            setInfo({
              loading: false, failed: false, me: me, rec: rec,
              canEdit: Boolean(me && (me.admin || (rec ? rec.owner === me.user : false)))
            });
            setFields({
              mode: rec && MODES.indexOf(rec.mode) !== -1 ? rec.mode : 'private',
              readers: rec && Array.isArray(rec.readers) ? rec.readers.join(', ') : '',
              writers: rec && Array.isArray(rec.writers) ? rec.writers.join(', ') : ''
            });
          });
        return function () { alive = false; };
      }, [sessionId]);

      react.useEffect(function () {
        function onKey(e) { if (e.key === 'Escape') onClose(); }
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, [onClose]);

      function onSave() {
        setSave({ busy: true, message: '' });
        api('POST', '/tenancy/sessions/' + encodeURIComponent(sessionId) + '/acl', {
          mode: fields.mode,
          readers: parseList(fields.readers),
          writers: parseList(fields.writers)
        }).then(function (res) {
          setSave(res.ok ? { busy: false, message: t('savedStatus') } : { busy: false, message: res.data?.error ?? String(res.status) });
        }).catch(function (e) { setSave({ busy: false, message: String(e) }); });
      }

      var fieldStyle = { flexDirection: 'column', gap: '4px', padding: '8px 0', display: 'flex' };
      var labelStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: '500' };
      var hintStyle = { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' };
      var controlStyle = { background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '5px 8px', fontSize: '13px', width: '100%', boxSizing: 'border-box' };

      var body;
      if (info.loading) body = react.createElement('p', { style: hintStyle }, '…');
      else if (info.failed) body = react.createElement('p', { style: hintStyle }, t('loadFailed'));
      else if (!info.rec) body = react.createElement('p', { style: hintStyle }, t('notShared'));
      else {
        body = react.createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
          react.createElement('div', { style: fieldStyle },
            react.createElement('span', { style: labelStyle }, t('ownerLabel')),
            react.createElement('code', { style: { fontSize: '13px' } }, info.rec.owner ?? t('unknownUser'))
          ),
          info.canEdit ? [
            react.createElement('div', { key: 'mode', style: fieldStyle },
              react.createElement('label', { style: labelStyle, htmlFor: 'tenancy-mode' }, t('accessLabel')),
              react.createElement('select', {
                id: 'tenancy-mode', style: controlStyle, value: fields.mode,
                onChange: function (e) { setFields(Object.assign({}, fields, { mode: e.target.value })); }
              },
                react.createElement('option', { value: 'private' }, t('modePrivate')),
                react.createElement('option', { value: 'team-read' }, t('modeTeamRead')),
                react.createElement('option', { value: 'team-rw' }, t('modeTeamRw'))
              )
            ),
            react.createElement('div', { key: 'readers', style: fieldStyle },
              react.createElement('label', { style: labelStyle, htmlFor: 'tenancy-readers' }, t('readersLabel')),
              react.createElement('input', {
                id: 'tenancy-readers', style: controlStyle, value: fields.readers,
                onChange: function (e) { setFields(Object.assign({}, fields, { readers: e.target.value })); }
              })
            ),
            react.createElement('div', { key: 'writers', style: fieldStyle },
              react.createElement('label', { style: labelStyle, htmlFor: 'tenancy-writers' }, t('writersLabel')),
              react.createElement('input', {
                id: 'tenancy-writers', style: controlStyle, value: fields.writers,
                onChange: function (e) { setFields(Object.assign({}, fields, { writers: e.target.value })); }
              })
            ),
            react.createElement('div', { key: 'actions', style: { display: 'flex', gap: '8px', marginTop: '10px' } },
              react.createElement('button', {
                type: 'button', disabled: save.busy,
                style: { background: 'var(--dsw-alias-button-primary-fill, #4f6ef7)', color: 'var(--dsw-alias-label-primary-inverted, #fff)', border: '0', borderRadius: '6px', padding: '6px 14px', fontSize: '13px', cursor: 'pointer' },
                onClick: onSave
              }, t('saveLabel'))
            ),
            save.message ? react.createElement('p', { key: 'status', style: hintStyle }, save.message) : null
          ] : react.createElement('div', { key: 'ro', style: fieldStyle },
            react.createElement('span', { style: labelStyle }, t('accessLabel')),
            react.createElement('span', { style: hintStyle }, t('mode' + ({ 'private': 'Private', 'team-read': 'TeamRead', 'team-rw': 'TeamRw' }[info.rec.mode] ?? 'Private'))),
            react.createElement('span', { style: hintStyle }, t('noPermission'))
          ));
      }

      return react.createElement('div', {
        style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
        onMouseDown: function (e) { if (e.target === e.currentTarget) onClose(); }
      },
        react.createElement('div', {
          role: 'dialog', 'aria-label': t('dialogTitle'),
          style: { background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary)', borderRadius: '12px', minWidth: '340px', maxWidth: '460px', maxHeight: '80vh', overflow: 'auto', padding: '18px', boxShadow: '0 8px 32px rgba(0,0,0,0.25)' }
        },
          react.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '6px' } },
            react.createElement('span', { style: { flex: 1, fontSize: '15px', fontWeight: '600' } }, t('dialogTitle')),
            react.createElement('button', {
              type: 'button', 'aria-label': t('closeLabel'), onClick: onClose,
              style: { background: 'transparent', border: '0', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: '16px', lineHeight: 1 }
            }, '\u00d7')
          ),
          react.createElement('code', { style: { display: 'block', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '8px' } }, sessionId),
          body
        )
      );
    }

    /** ── 会话头动作:共享按钮 ─────────────────────────────────────────────── */
    function ShareButton(props) {
      var sessionId = props.sessionId; var t = props.t;
      var openState = react.useState(false);
      var open = openState[0]; var setOpen = openState[1];
      return react.createElement('button', {
        type: 'button',
        onClick: function () { setOpen(true); },
        style: { background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', flex: 'none' }
      },
        t('shareLabel'),
        open ? react.createElement(ShareDialog, { sessionId: sessionId, t: t, onClose: function () { setOpen(false); } }) : null
      );
    }

    /** ── 会话头实用区:owner 徽章 ─────────────────────────────────────────── */
    function OwnerBadge(props) {
      var sessionId = props.sessionId; var t = props.t;
      var state = react.useState(null); // {owner, mode} | 'hidden'
      var info = state[0]; var setInfo = state[1];
      react.useEffect(function () {
        var alive = true;
        setInfo(null);
        api('GET', '/tenancy/sessions/' + encodeURIComponent(sessionId) + '/acl').then(function (res) {
          if (!alive) return;
          setInfo(res.ok && res.data && res.data.owner ? { owner: res.data.owner, mode: res.data.mode } : 'hidden');
        }).catch(function () { if (alive) setInfo('hidden'); });
        return function () { alive = false; };
      }, [sessionId]);
      if (info === null || info === 'hidden') return null;
      var modeText = { 'private': t('modePrivate'), 'team-read': t('modeTeamRead'), 'team-rw': t('modeTeamRw') }[info.mode] ?? '';
      return react.createElement('span', {
        title: t('badgeOwner') + ': ' + info.owner + (modeText ? ' · ' + t('badgeMode') + ': ' + modeText : ''),
        style: { display: 'inline-flex', alignItems: 'center', gap: '4px', flex: 'none', margin: '0 4px', padding: '1px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '1.6' }
      },
        '\ud83d\udc64 ' + info.owner + (modeText && info.mode !== 'private' ? ' · ' + modeText : '')
      );
    }

    /** ── 设置页卡片:whoami + 我的会话共享管理 ────────────────────────────── */
    function TenancyCard(props) {
      var t = props.t;
      var state = react.useState({ me: null, sessions: null });
      var info = state[0]; var setInfo = state[1];
      var dialogState = react.useState(null); // 正在编辑的 sessionId
      var dialogFor = dialogState[0]; var setDialogFor = dialogState[1];

      var refresh = react.useCallback(function () {
        Promise.all([whoami(), api('GET', '/tenancy/sessions')]).then(function (results) {
          var me = results[0];
          var res = results[1];
          setInfo({
            me: me,
            sessions: res.ok && Array.isArray(res.data.sessions) ? res.data.sessions : []
          });
        });
      }, []);
      react.useEffect(function () { refresh(); }, [refresh]);

      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' };
      var idStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 };
      var chipStyle = { flex: 'none', padding: '1px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' };
      var editButtonStyle = { flex: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '2px 8px', fontSize: '12px', cursor: 'pointer' };
      var modeText = function (m) { return { 'private': t('modePrivate'), 'team-read': t('modeTeamRead'), 'team-rw': t('modeTeamRw') }[m] ?? m; };

      var rows = info.sessions === null ? react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, '…')
        : info.sessions.length === 0 ? react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('sessionsEmpty'))
          : react.createElement('div', null, info.sessions.map(function (rec) {
            return react.createElement('div', { key: rec.sessionId, style: rowStyle },
              react.createElement('span', { style: idStyle, title: rec.sessionId }, rec.sessionId),
              react.createElement('span', { style: chipStyle }, (rec.owner ?? '?') + ' · ' + modeText(rec.mode)),
              react.createElement('button', {
                type: 'button', style: editButtonStyle,
                onClick: function () { setDialogFor(rec.sessionId); }
              }, t('shareLabel'))
            );
          }));

      return react.createElement('li', { style: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: '12px', listStyle: 'none' } },
        react.createElement('div', { style: { padding: '14px 16px' } },
          react.createElement('div', { style: { flexDirection: 'column', gap: '4px', display: 'flex', marginBottom: '10px' } },
            react.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: '600' } }, t('cardTitle')),
            react.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' } }, t('cardDescription'))
          ),
          react.createElement('p', { style: { margin: '0 0 8px', fontSize: '13px' } },
            t('whoamiLabel') + ': ',
            react.createElement('code', null, info.me ? info.me.user : t('unknownUser')),
            info.me && info.me.admin ? react.createElement('span', { style: chipStyle }, 'admin') : null
          ),
          react.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: '8px' } },
            react.createElement('p', { style: { margin: '0 0 4px', fontSize: '13px', fontWeight: '500', color: 'var(--dsw-alias-label-primary)' } }, t('sessionsLabel')),
            rows
          )
        ),
        dialogFor ? react.createElement(ShareDialog, { sessionId: dialogFor, t: t, onClose: function () { setDialogFor(null); refresh(); } }) : null
      );
    }

    function apply(ctx) {
      var slots = ctx.slots;

      ctx.effect(function () {
        return ctx.locale.register('tenancy', { en: en, zh: zh });
      }, 'tenancy: dictionaries');

      /** 包装层:渲染时绑定词典(注册先于词典生效),其余 props 原样透传。 */
      function withT(Component) {
        return function (props) {
          return react.createElement(Component, Object.assign({}, props, { t: ctx.locale.bind('tenancy') }));
        };
      }

      // 会话头动作区:共享按钮
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'tenancy-share',
          order: 35
        }, withT(ShareButton));
      });

      // 会话头实用区:owner 徽章
      ctx.slots.inject('conversation.session.header.utilities', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'tenancy-owner-badge',
          order: 90
        }, withT(OwnerBadge));
      });

      // 设置 → 插件:多租户卡片
      ctx.slots.inject('settings.plugin.item', function () {
        return ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'tenancy',
          id: 'tenancy',
          order: 45
        }, withT(TenancyCard));
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
