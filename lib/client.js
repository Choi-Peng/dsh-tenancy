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
    var inject = ['slots', 'locale', 'connection'];

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
      sessionUntitled: 'Untitled session',
      unknownUser: '(unknown)',
      logoutLabel: 'Sign out',
      invitesTitle: 'Invite codes',
      invitesDescription: 'One-time codes for new member sign-up at /register.',
      inviteGenerate: 'Generate',
      inviteCountLabel: 'Count',
      inviteNewCodes: 'New codes (shown only once — copy now):',
      inviteCopy: 'Copy',
      inviteCopied: 'Copied!',
      inviteStatusAvailable: 'Available',
      inviteStatusUsed: 'Used',
      inviteStatusRevoked: 'Revoked',
      inviteRevoke: 'Revoke',
      inviteLoadFailed: 'Failed to load invites.',
      inviteUsedBy: 'by',
      ucOpen: 'User center',
      ucIdentity: 'Signed in as',
      ucWorkspaces: 'Workspaces',
      ucWorkspacesDesc: 'Workspace owner records for this deployment.',
      wsEmpty: 'No workspaces yet.',
      wsUntitled: 'Untitled workspace',
      wsSessions: 'sessions',
      wsCreated: 'created',
      ucSessions: 'Sessions',
      ucPassword: 'Change password',
      pwCurrent: 'Current password',
      pwNew: 'New password',
      pwConfirm: 'Confirm new password',
      pwSubmit: 'Update password',
      pwBusy: 'Updating…',
      pwSuccess: 'Password updated.',
      pwMismatch: 'New passwords do not match.',
      pwWeak: 'New password must be at least 8 characters.',
      pwWrongCurrent: 'Current password is incorrect.',
      pwCurrentRequired: 'Enter your current password.',
      pwFailed: 'Update failed. Try again later.',
      ucAdmin: 'admin',
      ucLoading: 'Loading…',
      ucError: 'Failed to load.',
      ucLogout: 'Sign out',
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
      sessionUntitled: '未命名会话',
      unknownUser: '(未知)',
      logoutLabel: '登出',
      invitesTitle: '邀请码',
      invitesDescription: '一次性注册邀请码,新成员在 /register 页使用。',
      inviteGenerate: '生成邀请码',
      inviteCountLabel: '数量',
      inviteNewCodes: '新邀请码(仅显示一次,请立即复制):',
      inviteCopy: '复制',
      inviteCopied: '已复制!',
      inviteStatusAvailable: '可用',
      inviteStatusUsed: '已使用',
      inviteStatusRevoked: '已撤销',
      inviteRevoke: '撤销',
      inviteLoadFailed: '邀请码加载失败。',
      inviteUsedBy: '使用者',
      ucOpen: '用户中心',
      ucIdentity: '当前身份',
      ucWorkspaces: '工作区管理',
      ucWorkspacesDesc: '本部署的工作区 owner 一览。',
      wsEmpty: '还没有工作区。',
      wsUntitled: '未命名工作区',
      wsSessions: '个会话',
      wsCreated: '创建于',
      ucSessions: '会话管理',
      ucPassword: '修改密码',
      pwCurrent: '当前密码',
      pwNew: '新密码',
      pwConfirm: '确认新密码',
      pwSubmit: '更新密码',
      pwBusy: '更新中…',
      pwSuccess: '密码已更新。',
      pwMismatch: '两次输入的新密码不一致。',
      pwWeak: '新密码至少 8 位。',
      pwWrongCurrent: '当前密码不正确。',
      pwCurrentRequired: '请输入当前密码。',
      pwFailed: '更新失败,请稍后重试。',
      ucAdmin: '管理员',
      ucLoading: '加载中…',
      ucError: '加载失败。',
      ucLogout: '登出',
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

    /** ── 登出:先 POST Authelia 注销接口(幂等),再跳回门户登录页 ───────── */
    function doLogout() {
      try {
        fetch('/auth/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
      } catch (e) { /* 跳转本身即可结束前端会话 */ }
      window.location.assign('/auth/?rd=' + encodeURIComponent('/'));
    }

    function copyToClipboard(text, onDone) {
      function legacyCopy() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* 尽力而为 */ }
        document.body.removeChild(ta);
        onDone();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onDone, legacyCopy);
      } else legacyCopy();
    }

    /** ── 修改密码表单(用户中心)────────────────────────────────────────── */
    function PasswordForm(props) {
      var t = props.t;
      var fieldsState = react.useState({ current: '', next: '', confirm: '' });
      var fields = fieldsState[0]; var setFields = fieldsState[1];
      var stateState = react.useState({ busy: false, message: '', kind: '' }); // kind: ok | err
      var state = stateState[0]; var setState = stateState[1];

      var fieldStyle = { flexDirection: 'column', gap: '4px', padding: '6px 0', display: 'flex' };
      var labelStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '12px', fontWeight: '500' };
      var controlStyle = { background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '5px 8px', fontSize: '13px', width: '100%', boxSizing: 'border-box' };

      function submit() {
        if (fields.next !== fields.confirm) {
          setState({ busy: false, message: t('pwMismatch'), kind: 'err' });
          return;
        }
        if (String(fields.next).length < 8) {
          setState({ busy: false, message: t('pwWeak'), kind: 'err' });
          return;
        }
        setState({ busy: true, message: '', kind: '' });
        // 服务端错误响应是 text/plain,不走 api() 的 JSON 解析
        fetch('/tenancy/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword: fields.current, newPassword: fields.next }),
          credentials: 'same-origin'
        }).then(function (r) {
          return r.text().then(function (text) {
            return { ok: r.ok, status: r.status, text: text };
          });
        }).then(function (res) {
          if (res.ok) {
            setState({ busy: false, message: t('pwSuccess'), kind: 'ok' });
            setFields({ current: '', next: '', confirm: '' });
            return;
          }
          var err = String(res.text ?? '');
          var msg = err.indexOf('current-password-wrong') !== -1 ? t('pwWrongCurrent')
            : err.indexOf('password-weak') !== -1 ? t('pwWeak')
            : err.indexOf('current-password-required') !== -1 ? t('pwCurrentRequired')
            : t('pwFailed');
          setState({ busy: false, message: msg, kind: 'err' });
        }).catch(function () {
          setState({ busy: false, message: t('pwFailed'), kind: 'err' });
        });
      }

      return react.createElement('div', null,
        react.createElement('div', { style: fieldStyle },
          react.createElement('label', { style: labelStyle, htmlFor: 'uc-pw-current' }, t('pwCurrent')),
          react.createElement('input', {
            id: 'uc-pw-current', type: 'password', autoComplete: 'current-password', style: controlStyle, value: fields.current,
            onChange: function (e) { setFields(Object.assign({}, fields, { current: e.target.value })); }
          })
        ),
        react.createElement('div', { style: fieldStyle },
          react.createElement('label', { style: labelStyle, htmlFor: 'uc-pw-next' }, t('pwNew')),
          react.createElement('input', {
            id: 'uc-pw-next', type: 'password', autoComplete: 'new-password', style: controlStyle, value: fields.next,
            onChange: function (e) { setFields(Object.assign({}, fields, { next: e.target.value })); }
          })
        ),
        react.createElement('div', { style: fieldStyle },
          react.createElement('label', { style: labelStyle, htmlFor: 'uc-pw-confirm' }, t('pwConfirm')),
          react.createElement('input', {
            id: 'uc-pw-confirm', type: 'password', autoComplete: 'new-password', style: controlStyle, value: fields.confirm,
            onChange: function (e) { setFields(Object.assign({}, fields, { confirm: e.target.value })); }
          })
        ),
        react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '4px' } },
          react.createElement('button', {
            type: 'button', disabled: state.busy,
            style: { background: 'var(--dsw-alias-button-primary-fill, #4f6ef7)', color: 'var(--dsw-alias-label-primary-inverted, #fff)', border: '0', borderRadius: '6px', padding: '5px 14px', fontSize: '12px', cursor: 'pointer' },
            onClick: submit
          }, state.busy ? t('pwBusy') : t('pwSubmit')),
          state.message ? react.createElement('span', {
            style: { fontSize: '12px', color: state.kind === 'ok' ? '#2e9e5b' : '#d54941' }
          }, state.message) : null
        )
      );
    }

    /** ── 工作区管理(用户中心)─────────────────────────────────────────── */
    function WorkspaceList(props) {
      var t = props.t; var connection = props.connection;
      var state = react.useState({ loading: true, failed: false, rows: [] });
      var info = state[0]; var setInfo = state[1];

      react.useEffect(function () {
        var alive = true;
        // /tenancy/workspaces 提供旁车 owner 记录;connection.api.workspace.list
        // 提供标题与会话数(服务端已按可见性过滤,与 owner 一览对齐)。
        // 注意:客户端 API 域名为单数 workspace(复数 workspaces 不存在,会 TypeError 被 catch 吞掉)
        var wsPromise = api('GET', '/tenancy/workspaces');
        var metaPromise = Promise.resolve()
          .then(function () { return connection.api.workspace.list({}); })
          .then(function (response) {
            var meta = {};
            var items = response && response.result && response.result.ok && Array.isArray(response.result.value && response.result.value.items)
              ? response.result.value.items : [];
            for (var i = 0; i < items.length; i += 1) {
              var row = items[i];
              if (row && row.workspaceId) {
                meta[row.workspaceId] = {
                  title: row.title,
                  count: Array.isArray(row.sessionIds) ? row.sessionIds.length : 0
                };
              }
            }
            return meta;
          })
          .catch(function () { return {}; });
        Promise.all([wsPromise, metaPromise]).then(function (results) {
          if (!alive) return;
          var res = results[0];
          var meta = results[1] || {};
          var rows = res.ok && Array.isArray(res.data.workspaces) ? res.data.workspaces : [];
          setInfo({
            loading: false,
            failed: !res.ok,
            rows: rows.map(function (rec) {
              var m = meta[rec.workspaceId];
              var title = m && typeof m.title === 'string' && m.title.trim() !== '' ? m.title : t('wsUntitled');
              return {
                workspaceId: rec.workspaceId,
                owner: rec.owner ?? '?',
                createdAt: rec.createdAt ?? null,
                title: title,
                count: m ? m.count : 0
              };
            })
          });
        }).catch(function () { if (alive) setInfo({ loading: false, failed: true, rows: [] }); });
        return function () { alive = false; };
      }, []);

      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 0' };
      var titleStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 };
      var chipStyle = { flex: 'none', padding: '1px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' };

      var body;
      if (info.loading) body = react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('ucLoading'));
      else if (info.failed) body = react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('ucError'));
      else if (info.rows.length === 0) body = react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('wsEmpty'));
      else body = react.createElement('div', null, info.rows.map(function (rec) {
        return react.createElement('div', { key: rec.workspaceId, style: rowStyle },
          react.createElement('span', { style: titleStyle, title: rec.workspaceId }, rec.title),
          react.createElement('span', { style: chipStyle }, rec.owner),
          react.createElement('span', { style: chipStyle }, rec.count + ' ' + t('wsSessions')),
          rec.createdAt ? react.createElement('span', { style: chipStyle }, t('wsCreated') + ' ' + new Date(rec.createdAt).toLocaleDateString()) : null
        );
      }));

      return react.createElement('div', null,
        react.createElement('p', { style: { margin: '0 0 4px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, t('ucWorkspacesDesc')),
        body
      );
    }

    /** ── 我的会话管理(用户中心)───────────────────────────────────────── */
    function MySessions(props) {
      var t = props.t; var connection = props.connection;
      var state = react.useState({ loading: true, sessions: [], titles: {} });
      var info = state[0]; var setInfo = state[1];
      var dialogState = react.useState(null);
      var dialogFor = dialogState[0]; var setDialogFor = dialogState[1];

      var refresh = react.useCallback(function () {
        var titlesPromise = Promise.resolve()
          .then(function () { return connection.api.sessions.list({}); })
          .then(function (response) {
            var titles = {};
            var items = response && response.result && response.result.ok && Array.isArray(response.result.value && response.result.value.items)
              ? response.result.value.items : [];
            for (var i = 0; i < items.length; i += 1) {
              var row = items[i];
              var title = row && row.projections && row.projections.values && row.projections.values.title;
              if (row && row.sessionId && title) titles[row.sessionId] = title;
            }
            return titles;
          })
          .catch(function () { return {}; });
        Promise.all([api('GET', '/tenancy/sessions'), titlesPromise]).then(function (results) {
          var res = results[0];
          setInfo({
            loading: false,
            sessions: res.ok && Array.isArray(res.data.sessions) ? res.data.sessions : [],
            titles: results[1] || {}
          });
        });
      }, []);
      react.useEffect(function () { refresh(); }, [refresh]);

      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 0' };
      var titleStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 };
      var chipStyle = { flex: 'none', padding: '1px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' };
      var editButtonStyle = { flex: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '2px 8px', fontSize: '12px', cursor: 'pointer' };
      var modeText = function (m) { return { 'private': t('modePrivate'), 'team-read': t('modeTeamRead'), 'team-rw': t('modeTeamRw') }[m] ?? m; };
      var sessionTitle = function (rec) {
        var title = info.titles && info.titles[rec.sessionId];
        return typeof title === 'string' && title.trim() !== '' ? title : t('sessionUntitled');
      };

      var rows = info.loading ? react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('ucLoading'))
        : info.sessions.length === 0 ? react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('sessionsEmpty'))
          : react.createElement('div', null, info.sessions.map(function (rec) {
            return react.createElement('div', { key: rec.sessionId, style: rowStyle },
              react.createElement('span', { style: titleStyle, title: rec.sessionId }, sessionTitle(rec)),
              react.createElement('span', { style: chipStyle }, (rec.owner ?? '?') + ' · ' + modeText(rec.mode)),
              react.createElement('button', {
                type: 'button', style: editButtonStyle,
                onClick: function () { setDialogFor(rec.sessionId); }
              }, t('shareLabel'))
            );
          }));

      return react.createElement('div', null,
        rows,
        dialogFor ? react.createElement(ShareDialog, { sessionId: dialogFor, t: t, onClose: function () { setDialogFor(null); refresh(); } }) : null
      );
    }

    /** ── 右上角常驻用户中心入口(fixed 定位,挂载于 root 级常驻槽位)────── */
    /** ── 拖拽位置持久化:pos 统一存入口圆片左上角坐标,面板由它推导 ─────── */
    var UC_PILL_PANEL_GAP = 42; // 面板默认 top:54px 与圆片 top:12px 的间距

    function clampPos(pos, panelW, panelH) {
      var maxX = Math.max(0, window.innerWidth - panelW);
      var maxY = Math.max(0, window.innerHeight - Math.min(panelH, window.innerHeight));
      return {
        x: Math.min(Math.max(0, pos.x), maxX),
        y: Math.min(Math.max(0, pos.y), maxY)
      };
    }

    function loadUcPos() {
      try {
        var raw = localStorage.getItem('tenancy.uc.pos');
        if (raw) return JSON.parse(raw);
      } catch (e) { /* 解析失败按默认位置 */ }
      return null;
    }

    function saveUcPos(pos) {
      try { localStorage.setItem('tenancy.uc.pos', JSON.stringify(pos)); } catch (e) { /* 存储不可用不致命 */ }
    }

    function defaultUcPos() {
      return { x: Math.max(8, window.innerWidth - 394), y: 12 };
    }

    /** 由圆片坐标推导面板左上角(圆片正下方,间距 UC_PILL_PANEL_GAP)。 */
    function panelPosFromPill(pos) {
      return clampPos({ x: pos.x, y: pos.y + UC_PILL_PANEL_GAP }, 380, window.innerHeight);
    }

    function UserCenter(props) {
      var t = props.t; var connection = props.connection;
      var openState = react.useState(false);
      var open = openState[0]; var setOpen = openState[1];
      var meState = react.useState(null);
      var me = meState[0]; var setMe = meState[1];
      // 面板拖拽位置;null = 未拖过,用默认右上角锚点定位;dragging 期间禁止面板滚动溢出
      var posState = react.useState(loadUcPos());
      var pos = posState[0]; var setPos = posState[1];
      var draggingState = react.useState(false);
      var dragging = draggingState[0]; var setDragging = draggingState[1];
      // 拖拽会话数据:经 ref 在 document 监听器间共享,避免闭包过期;dragged 标记
      // 一次 mousedown→up 若产生位移(>4px)则视为拖拽而非点击,不当场开面板,
      // 并短暂置位以抑制随后的 click 误触外部关闭。
      var dragRef = react.useRef(null);
      var suppressCloseRef = react.useRef(false);

      react.useEffect(function () {
        var alive = true;
        whoami().then(function (m) { if (alive) setMe(m); });
        return function () { alive = false; };
      }, []);

      // 面板拖拽:按下 header 起手,移动更新坐标并持久化,抬起结束。
      // 监听挂在 document 上,指针划出面板也能跟手。
      function startPanelDrag(e) {
        if (e.button !== 0) return;
        e.preventDefault(); // 阻止文字选中等默认行为,避免拖拽被打断
        // 拖拽基准是面板当前坐标(由圆片坐标推导);回写时还原为圆片坐标,
        // 保证关闭面板后入口圆片落回面板最后一次位置上方。
        var base = pos ? panelPosFromPill(pos) : { x: defaultUcPos().x, y: 12 + UC_PILL_PANEL_GAP };
        dragRef.current = {
          startX: e.clientX, startY: e.clientY,
          baseX: base.x, baseY: base.y, moved: false
        };
        function onMove(ev) {
          var d = dragRef.current;
          if (!d) return;
          var dx = ev.clientX - d.startX;
          var dy = ev.clientY - d.startY;
          if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // 抖动容忍,不视为拖拽
          d.moved = true;
          var next = clampPos({ x: d.baseX + dx, y: d.baseY + dy }, 380, window.innerHeight);
          var pillPos = { x: next.x, y: Math.max(0, next.y - UC_PILL_PANEL_GAP) };
          setPos(pillPos);
          setDragging(true);
          saveUcPos(pillPos);
        }
        function onUp() {
          dragRef.current = null;
          setDragging(false);
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }

      // ESC 与点击外部关闭(拖拽刚结束时短暂豁免)
      react.useEffect(function () {
        if (!open) return undefined;
        function onKey(e) { if (e.key === 'Escape') setOpen(false); }
        function onDown(e) {
          if (suppressCloseRef.current) return;
          var el = e.target;
          while (el && el !== document.body) {
            if (el.getAttribute && el.getAttribute('data-uc') === 'true') return;
            el = el.parentNode;
          }
          setOpen(false);
        }
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return function () {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onDown);
        };
      }, [open]);

      // 入口圆片拖拽:与面板同构——超过阈值视为拖拽,不切换开合状态;
      // 拖拽结束时以圆片左上角为基准换算面板坐标,使面板落位与视觉衔接。
      function startPillDrag(e) {
        if (e.button !== 0) return;
        var sx = e.clientX; var sy = e.clientY;
        var pill = e.currentTarget;
        var rect = pill.getBoundingClientRect();
        var moved = false;
        function onMove(ev) {
          var dx = ev.clientX - sx;
          var dy = ev.clientY - sy;
          if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          moved = true;
          var pillH = rect.height;
          // pos 存圆片坐标;面板打开时由其推导,拖拽中实时换算即可对齐。
          var next = clampPos({ x: rect.left + dx, y: rect.top + dy }, rect.width, pillH);
          setPos(next);
          saveUcPos(next);
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (moved) {
            // 拖拽而非点击:抑制本次开合切换与紧随的外部点击关闭,稍后复位。
            suppressCloseRef.current = true;
            setTimeout(function () { suppressCloseRef.current = false; }, 200);
          } else {
            setOpen(function (v) { return !v; });
          }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }

      var chipStyle = { flex: 'none', padding: '1px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' };
      var logoutBtnStyle = { flex: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '3px 12px', fontSize: '12px', cursor: 'pointer' };
      var sectionTitleStyle = { margin: '0 0 4px', fontSize: '13px', fontWeight: '500', color: 'var(--dsw-alias-label-primary)' };

      function section(title, Component) {
        return react.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: '10px', marginTop: '10px' } },
          react.createElement('p', { style: sectionTitleStyle }, title),
          react.createElement(Component, { t: t, connection: connection })
        );
      }

      var initial = me && me.user ? me.user.charAt(0).toUpperCase() : '?';
      var pillStyle = {
        position: 'fixed', top: '12px', right: '14px', zIndex: 9500,
        display: 'flex', alignItems: 'center', gap: '6px', flex: 'none',
        background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '999px',
        padding: '3px 10px 3px 4px', fontSize: '12px', cursor: 'pointer',
        boxShadow: '0 2px 10px rgba(0,0,0,0.15)', userSelect: 'none'
      };
      // 恢复的旧坐标可能超出当前视口(窗口缩小过),渲染前夹回;圆片尺寸取上限估值即可。
      var pillPos = pos ? clampPos(pos, 160, 34) : null;
      if (pillPos) { pillStyle.left = pillPos.x + 'px'; pillStyle.top = pillPos.y + 'px'; pillStyle.right = 'auto'; }
      var avatarStyle = {
        width: '24px', height: '24px', borderRadius: '999px', flex: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--dsw-alias-button-primary-fill, #4f6ef7)',
        color: 'var(--dsw-alias-label-primary-inverted, #fff)', fontSize: '12px', fontWeight: '600'
      };

      // 面板定位:拖过则用持久化坐标,否则保持右上角默认锚点;
      // 拖拽中禁止面板自身滚动(滚动条会与跟手位移叠加产生抖动)。
      var panelStyle = {
        position: 'fixed', zIndex: 9600,
        width: '380px', maxWidth: 'calc(100vw - 28px)', maxHeight: 'calc(100vh - 70px)',
        overflowY: dragging ? 'hidden' : 'auto', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px',
        padding: '14px 16px', boxShadow: '0 8px 32px rgba(0,0,0,0.25)'
      };
      var panelPos = pos ? panelPosFromPill(pos) : null;
      if (panelPos) { panelStyle.left = panelPos.x + 'px'; panelStyle.top = panelPos.y + 'px'; }
      else { panelStyle.top = '54px'; panelStyle.right = '14px'; }

      return react.createElement('div', { 'data-uc': 'true' },
        react.createElement('div', {
          'data-uc': 'true', role: 'button', tabIndex: 0, title: t('ucOpen'),
          'aria-expanded': open, 'aria-label': t('ucOpen'),
          style: pillStyle,
          onMouseDown: startPillDrag,
          onKeyDown: function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); }
          }
        },
          react.createElement('span', { style: avatarStyle }, initial),
          react.createElement('span', { style: { maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, me && me.user ? me.user : '…')
        ),
        open ? react.createElement('div', {
          'data-uc': 'true', role: 'dialog', 'aria-label': t('ucOpen'),
          style: panelStyle
        },
          react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'move', userSelect: 'none' }, onMouseDown: startPanelDrag },
            react.createElement('span', { style: { flex: 1, fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              t('ucIdentity') + ': ',
              react.createElement('code', null, me && me.user ? me.user : t('ucLoading')),
              me && me.admin ? react.createElement('span', { style: chipStyle }, t('ucAdmin')) : null
            ),
            react.createElement('button', {
              type: 'button', title: t('ucLogout'), style: logoutBtnStyle,
              onClick: doLogout
            }, t('ucLogout'))
          ),
          section(t('ucWorkspaces'), WorkspaceList),
          section(t('ucSessions'), MySessions),
          section(t('ucPassword'), PasswordForm),
          me && me.admin ? section(t('ucInvites'), InviteManager) : null
        ) : null
      );
    }

    /** ── 管理员卡片:一次性邀请码管理 ────────────────────────────────────── */
    function InviteManager(props) {
      var t = props.t;
      var listState = react.useState(null); // 邀请码数组 | null(加载失败)
      var list = listState[0]; var setList = listState[1];
      var codesState = react.useState(null); // 刚生成的明码数组(仅此一次)
      var newCodes = codesState[0]; var setNewCodes = codesState[1];
      var busyState = react.useState(false);
      var busy = busyState[0]; var setBusy = busyState[1];
      var copiedState = react.useState('');
      var copied = copiedState[0]; var setCopied = copiedState[1];

      var load = react.useCallback(function () {
        api('GET', '/tenancy/invites').then(function (res) {
          setList(res.ok && Array.isArray(res.data.invites) ? res.data.invites : null);
        }).catch(function () { setList(null); });
      }, []);
      react.useEffect(function () { load(); }, [load]);

      function generate() {
        setBusy(true);
        api('POST', '/tenancy/invites', { count: 1 }).then(function (res) {
          setBusy(false);
          if (res.ok && Array.isArray(res.data.invites)) {
            setNewCodes(res.data.invites.map(function (x) { return x.code; }));
            load();
          } else setNewCodes([]);
        }).catch(function () { setBusy(false); setNewCodes([]); });
      }

      function revoke(id) {
        api('POST', '/tenancy/invites/revoke', { id: id }).then(function () { load(); });
      }

      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12px' };
      var idStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 };
      var smallButtonStyle = { flex: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '1px 8px', fontSize: '11px', cursor: 'pointer' };
      function statusChip(rec) {
        var used = Boolean(rec.usedBy);
        var revoked = Boolean(rec.revoked);
        var color = used ? 'var(--dsw-alias-label-tertiary)' : revoked ? '#d54941' : '#2e9e5b';
        var label = used ? t('inviteStatusUsed') : revoked ? t('inviteStatusRevoked') : t('inviteStatusAvailable');
        var title = rec.createdAt ? new Date(rec.createdAt).toLocaleString() : '';
        return react.createElement('span', {
          title: title,
          style: { flex: 'none', padding: '0 8px', borderRadius: '999px', border: '1px solid ' + color, color: color, fontSize: '11px', lineHeight: '1.7' }
        }, label);
      }

      var body;
      if (list === null) body = react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('inviteLoadFailed'));
      else if (list.length === 0) body = react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, '—');
      else body = react.createElement('div', null, list.map(function (rec) {
        return react.createElement('div', { key: rec.id, style: rowStyle },
          react.createElement('span', { style: idStyle, title: rec.usedBy ? t('inviteUsedBy') + ': ' + rec.usedBy : rec.id }, rec.usedBy ? rec.id + ' → ' + rec.usedBy : rec.id),
          statusChip(rec),
          !rec.usedBy && !rec.revoked ? react.createElement('button', { type: 'button', style: smallButtonStyle, onClick: function () { revoke(rec.id); } }, t('inviteRevoke')) : null
        );
      }));

      return react.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: '10px', marginTop: '4px' } },
        react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
          react.createElement('span', { style: { margin: 0, fontSize: '13px', fontWeight: '500', color: 'var(--dsw-alias-label-primary)', flex: 1 } }, t('invitesTitle')),
          react.createElement('button', {
            type: 'button', disabled: busy,
            style: { background: 'var(--dsw-alias-button-primary-fill, #4f6ef7)', color: 'var(--dsw-alias-label-primary-inverted, #fff)', border: '0', borderRadius: '6px', padding: '3px 12px', fontSize: '12px', cursor: 'pointer' },
            onClick: generate
          }, busy ? '…' : t('inviteGenerate'))
        ),
        react.createElement('p', { style: { margin: '0 0 6px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, t('invitesDescription')),
        Array.isArray(newCodes) ? react.createElement('div', { style: { background: 'var(--dsw-alias-bg-layer-2)', border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '8px 10px', marginBottom: '8px' } },
          newCodes.length === 0 ? react.createElement('p', { style: { margin: 0, fontSize: '12px', color: '#d54941' } }, t('inviteLoadFailed'))
            : [
              react.createElement('p', { key: 'hint', style: { margin: '0 0 4px', fontSize: '12px', fontWeight: '500' } }, t('inviteNewCodes')),
              newCodes.map(function (code) {
                return react.createElement('div', { key: code, style: rowStyle },
                  react.createElement('code', { style: idStyle }, code),
                  react.createElement('button', {
                    type: 'button', style: smallButtonStyle,
                    onClick: function () {
                      copyToClipboard(code, function () { setCopied(code); setTimeout(function () { setCopied(''); }, 1500); });
                    }
                  }, copied === code ? t('inviteCopied') : t('inviteCopy'))
                );
              })
            ]
        ) : null,
        body
      );
    }

    /** ── 设置页卡片:whoami + 我的会话共享管理(可折叠,与插件配置卡片同构) ── */
    function TenancyCard(props) {
      var t = props.t;
      var state = react.useState({ me: null, sessions: null });
      var info = state[0]; var setInfo = state[1];
      var dialogState = react.useState(null); // 正在编辑的 sessionId
      var dialogFor = dialogState[0]; var setDialogFor = dialogState[1];
      var openState = react.useState(false); // 折叠态:与 shell 插件卡片一致,默认收起
      var open = openState[0]; var setOpen = openState[1];

      var refresh = react.useCallback(function () {
        // session.list 提供会话标题(projections.values.title);与 ACL 记录按 sessionId 合并,
        // 标题取不到时回退显示 sessionId。
        var titlesPromise = Promise.resolve()
          .then(function () { return props.connection.api.sessions.list({}); })
          .then(function (response) {
            var titles = {};
            var items = response && response.result && response.result.ok && Array.isArray(response.result.value && response.result.value.items)
              ? response.result.value.items : [];
            for (var i = 0; i < items.length; i += 1) {
              var row = items[i];
              var title = row && row.projections && row.projections.values && row.projections.values.title;
              if (row && row.sessionId && title) titles[row.sessionId] = title;
            }
            return titles;
          })
          .catch(function () { return {}; });
        Promise.all([whoami(), api('GET', '/tenancy/sessions'), titlesPromise]).then(function (results) {
          var me = results[0];
          var res = results[1];
          setInfo({
            me: me,
            sessions: res.ok && Array.isArray(res.data.sessions) ? res.data.sessions : [],
            titles: results[2] || {}
          });
        });
      }, []);
      react.useEffect(function () { refresh(); }, [refresh]);

      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' };
      var titleStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 };
      var chipStyle = { flex: 'none', padding: '1px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' };
      var editButtonStyle = { flex: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '2px 8px', fontSize: '12px', cursor: 'pointer' };
      var modeText = function (m) { return { 'private': t('modePrivate'), 'team-read': t('modeTeamRead'), 'team-rw': t('modeTeamRw') }[m] ?? m; };
      var sessionTitle = function (rec) {
        var title = info.titles && info.titles[rec.sessionId];
        return typeof title === 'string' && title.trim() !== '' ? title : t('sessionUntitled');
      };

      var rows = info.sessions === null ? react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, '…')
        : info.sessions.length === 0 ? react.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('sessionsEmpty'))
          : react.createElement('div', null, info.sessions.map(function (rec) {
            var label = sessionTitle(rec);
            return react.createElement('div', { key: rec.sessionId, style: rowStyle },
              react.createElement('span', { style: titleStyle, title: rec.sessionId }, label),
              react.createElement('span', { style: chipStyle }, (rec.owner ?? '?') + ' · ' + modeText(rec.mode)),
              react.createElement('button', {
                type: 'button', style: editButtonStyle,
                onClick: function () { setDialogFor(rec.sessionId); }
              }, t('shareLabel'))
            );
          }));

      // 与 dsh-client-ui-settings-plugins 的 PluginCard 同构:li 卡片 chrome + 可折叠 header
      var cardStyle = {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: '12px',
        listStyle: 'none',
        transition: 'border-color .16s, background .16s'
      };
      if (open) {
        cardStyle.background = 'var(--dsw-alias-bg-layer-2)';
        cardStyle.borderColor = 'var(--dsw-alias-label-dimmed)';
      }

      return react.createElement('li', { style: cardStyle },
        react.createElement('button', {
          type: 'button',
          'aria-expanded': open,
          style: { appearance: 'none', width: '100%', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: '0', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px' },
          onClick: function () { setOpen(!open); }
        },
          react.createElement('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, gap: '4px', minWidth: 0 } },
            react.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: '600', lineHeight: '1.4' } }, t('cardTitle')),
            react.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', lineHeight: '1.5' } }, t('cardDescription'))
          ),
          react.createElement('svg', {
            style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : undefined },
            width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'
          },
            react.createElement('path', { d: 'm6 9 6 6 6-6' })
          )
        ),
        open ? react.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', padding: '10px 0 14px' } },
          react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 8px' } },
            react.createElement('p', { style: { margin: 0, fontSize: '13px', flex: 1 } },
              t('whoamiLabel') + ': ',
              react.createElement('code', null, info.me ? info.me.user : t('unknownUser')),
              info.me && info.me.admin ? react.createElement('span', { style: chipStyle }, 'admin') : null
            ),
            react.createElement('button', {
              type: 'button',
              title: t('logoutLabel'),
              style: { flex: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '3px 12px', fontSize: '12px', cursor: 'pointer' },
              onClick: doLogout
            }, t('logoutLabel'))
          ),
          react.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: '8px' } },
            react.createElement('p', { style: { margin: '0 0 4px', fontSize: '13px', fontWeight: '500', color: 'var(--dsw-alias-label-primary)' } }, t('sessionsLabel')),
            rows
          ),
          info.me && info.me.admin ? react.createElement(InviteManager, { t: t }) : null
        ) : null,
        dialogFor ? react.createElement(ShareDialog, { sessionId: dialogFor, t: t, onClose: function () { setDialogFor(null); refresh(); } }) : null
      );
    }

    function apply(ctx) {
      var slots = ctx.slots;

      ctx.effect(function () {
        return ctx.locale.register('tenancy', { en: en, zh: zh });
      }, 'tenancy: dictionaries');

      /** 包装层:渲染时绑定词典(注册先于词典生效)与 connection(会话标题查询),其余 props 原样透传。 */
      function withT(Component) {
        return function (props) {
          return react.createElement(Component, Object.assign({}, props, {
            t: ctx.locale.bind('tenancy'),
            connection: ctx.get('connection')
          }));
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

      // 设置 → 插件:多租户卡片(keyed 槽位,与 shell 卡片同形——只带 key;
      // 卡片能否显示取决于宿主是否 serve 'tenancy' 命名空间,见 index.js 的 TENANCY_NS)
      ctx.slots.inject('settings.plugin.item', function () {
        return ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'tenancy'
        }, withT(TenancyCard));
      });

      // 右上角常驻用户中心入口:挂 root 级常驻槽位(sidebar.footer.action 始终挂载),
      // 组件以 position:fixed 渲染在视口右上角,与挂载点无关;含工作区管理 / 会话管理 /
      // 修改密码 / 邀请码管理(管理员) / 登出
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'tenancy-user-center',
          order: 10
        }, withT(UserCenter));
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
