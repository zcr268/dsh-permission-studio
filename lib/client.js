/**
 * dsh-permission-studio —— 浏览器半。
 *
 * 通过官方 settings.section slot 向 DSH 设置面板注册「权限档位」页：
 * DSH 自己渲染导航项与内容区，插件只提供一个 React 组件（内部指向
 * /permission-studio/ 的 iframe，承载 Host 侧自包含管理页）。
 *
 * 关键约束（踩过的坑）：
 *  1. 不向 React 托管的设置 DOM 插入节点 —— 切换设置页时 React 会重建 dialog，
 *     未知子节点会打断 diff，导致整棵树崩溃、侧边栏「更多」按钮被卸载。
 *  2. `slots` 是 @deepseek-ai/dsh-client-ui-renderer 提供的 cordis 服务。
 *     package.json 的 dsh.client.inject 必须先声明该插件，
 *     同时本插件对象的 inject 要含 'slots'，否则 fiber 未就绪即访问 ctx.slots 会抛错，
 *     表现为「web boot: 1 entry did not activate / dsh-permission-studio: failed」。
 *
 * 打包格式与 DSH 内置客户端插件一致：window.__ModuleLoader__.load({id, factory})。
 */
window.__ModuleLoader__.load({
  id: 'dsh-permission-studio',
  factory: (require) => {
    'use strict'

    var React = require('react')

    var NAME = 'dsh-permission-studio'
    var SECTION_ID = 'permission-studio'
    var SECTION_LABEL = '权限档位'

    /** 设置页内容：占满内容区的 iframe，指向 Host 侧管理页。 */
    function PermissionStudioSection() {
      return React.createElement('iframe', {
        src: '/permission-studio/',
        title: SECTION_LABEL,
        'aria-label': SECTION_LABEL + '编辑',
        style: {
          width: '100%',
          height: '100%',
          minHeight: '560px',
          border: 'none',
          display: 'block',
          background: '#fff',
          colorScheme: 'light'
        }
      })
    }

    function apply(ctx) {
      // fiber 已声明 inject: ['slots']，到这里 slots 必然就绪
      var slots = ctx.slots
      if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return

      function register() {
        return slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 30,
          label: function () { return SECTION_LABEL },
          inject: function () { return {} }
        }, PermissionStudioSection)
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          var dispose = slots.inject('settings.section', register)
          return function () {
            try { if (typeof dispose === 'function') dispose() } catch (e) {}
          }
        }, NAME + ': settings section')
        ctx.effect(function () {
          var decorator = createBadgeDecorator()
          decorator.start()
          return function () { try { decorator.stop() } catch (e) {} }
        }, NAME + ': preset badges')
      } else {
        slots.inject('settings.section', register)
        createBadgeDecorator().start()
      }
    }

    /**
     * 原生档位下拉的徽标装饰。
     *
     * DSH 的下拉按固定 id 出图标（只有内置四档有），自定义档位必然空着、文字也不齐。
     * 这里在下拉项里「补一个」徽标节点，占据原生图标的位置：
     *  - 只插入自己创建的节点，从不删改 React 的节点（删改会打断 diff，之前踩过
     *    侧边栏「更多」按钮被卸载的坑）；
     *  - 已经自带原生图标的项跳过，避免出现两个图标；
     *  - 徽标 pointer-events:none，不影响点击选中。
     */
    function createBadgeDecorator() {
      var iconByName = Object.create(null)
      var observer = null
      var timer = 0

      function refreshIcons() {
        fetch('/permission-studio/api', { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null })
          .then(function (data) {
            if (!data || !data.presets) return
            var map = Object.create(null)
            Object.keys(data.presets).forEach(function (id) {
              var p = data.presets[id] || {}
              if (!p.iconSvg) return
              if (p.name) map[String(p.name)] = p.iconSvg
              map[String(id)] = p.iconSvg
            })
            iconByName = map
            decorate()
          })
          .catch(function () {})
      }

      function makeBadge(svg) {
        var wrap = document.createElement('span')
        wrap.setAttribute('data-ps-badge', '1')
        wrap.setAttribute('aria-hidden', 'true')
        wrap.style.cssText = 'display:inline-flex;align-items:center;flex:none;width:16px;height:16px;margin-right:6px;color:currentColor;opacity:1;pointer-events:none'
        wrap.innerHTML = svg
        return wrap
      }

      function isOurs(node) {
        return !!(node && node.getAttribute && node.getAttribute('data-ps-badge') === '1')
      }

      /** 标签之前是否已有「非本插件」的图标（原生图标），有就不能再加。 */
      function hasNativeIcon(host, label) {
        var kids = host.children
        for (var i = 0; i < kids.length; i++) {
          var ch = kids[i]
          if (ch === label) break
          if (isOurs(ch)) continue
          if (ch.tagName === 'svg') return true
          if (ch.querySelector && ch.querySelector('svg')) return true
        }
        return false
      }

      /**
       * 把某个容器的徽标同步到「当前标签文字」对应的图标。
       *
       * 必须每次都重新对齐，不能只在首次插入：
       * 切换档位时 React 只改标签文字、复用同一个按钮节点，我们插进去的旧徽标
       * 不会被它清掉，于是会出现「旧徽标 + 新档位原生图标」并排的怪状。
       * 这里只删除本插件自己插入的节点（data-ps-badge），绝不碰 React 的节点。
       */
      function reconcile(host, label) {
        var text = (label.textContent || '').trim()
        var svg = iconByName[text]
        var native = hasNativeIcon(host, label)
        var badge = null
        var kids = host.children
        for (var i = 0; i < kids.length; i++) if (isOurs(kids[i])) badge = kids[i]
        if (!svg || native) {
          if (badge) badge.parentNode.removeChild(badge)
          return
        }
        if (!badge) {
          badge = makeBadge(svg)
          host.insertBefore(badge, label)
        } else if (badge.getAttribute('data-icon') !== text) {
          badge.innerHTML = svg
        }
        badge.setAttribute('data-icon', text)
      }

      /** 档位触发器（输入框左下角）：[图标?][标签 span][chevron span] */
      function decorateTriggers() {
        var buttons = document.querySelectorAll('button')
        for (var i = 0; i < buttons.length; i++) {
          var b = buttons[i]
          if (b.getAttribute('role') === 'menuitem') continue
          var kids = b.children
          if (kids.length < 2 || kids.length > 4) continue
          var tail = kids[kids.length - 1]
          if (tail.tagName !== 'SPAN' || !tail.querySelector('svg')) continue
          var label = null
          for (var j = 0; j < kids.length; j++) {
            if (kids[j].tagName === 'SPAN' && !isOurs(kids[j]) && kids[j].querySelector('svg') === null) { label = kids[j]; break }
          }
          if (!label || !(label.textContent || '').trim()) continue
          reconcile(b, label)
        }
      }

      /** 下拉菜单项：[图标?][标签 span][勾选 svg] */
      function decorateMenuItems() {
        var items = document.querySelectorAll('[role="menuitem"]')
        for (var i = 0; i < items.length; i++) {
          var item = items[i]
          var label = null
          for (var j = 0; j < item.children.length; j++) {
            var ch = item.children[j]
            if (ch.tagName === 'SPAN' && !isOurs(ch) && (ch.textContent || '').trim()) { label = ch; break }
          }
          if (!label) continue
          reconcile(item, label)
        }
      }

      function decorate() {
        decorateTriggers()
        decorateMenuItems()
      }

      function schedule() {
        if (timer) return
        timer = setTimeout(function () { timer = 0; decorate() }, 60)
      }

      return {
        start: function () {
          refreshIcons()
          setInterval(refreshIcons, 15000)
          observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true })
        },
        stop: function () {
          if (observer) observer.disconnect()
          observer = null
          if (timer) { clearTimeout(timer); timer = 0 }
        }
      }
    }

    return {
      name: NAME,
      inject: ['slots'],
      apply: apply
    }
  }
})
