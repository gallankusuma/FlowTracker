f = '/var/www/idxflash/src/app/admin/layout.tsx'
t = open(f).read()

# Replace the broker-stalker sidebar entry to use external link with target blank
old = "  { href: '/admin/broker-stalker', label: 'Broker Stalker', icon: Eye },"
new = "  { href: 'http://76.13.22.155:3200/broker-activity', label: 'Broker Stalker ↗', icon: Eye, external: true },"
t = t.replace(old, new)

# Now we need to update the Link rendering to handle external links
# Find the link rendering block and add target="_blank" for external links
old_link = """              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {sidebarOpen && <span className="font-medium">{link.label}</span>}
              </Link>"""

new_link = """              <Link
                key={link.href}
                href={link.href}
                {...((link as any).external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {sidebarOpen && <span className="font-medium">{link.label}</span>}
              </Link>"""

t = t.replace(old_link, new_link)

open(f, 'w').write(t)

# Verify
content = open(f).read()
if 'external: true' in content:
    print('External link OK')
if 'target:' in content:
    print('target=_blank OK')
print('Done')
