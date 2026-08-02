'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Newspaper,
  TrendingUp,
  Users,
  Settings,
  Menu,
  X,
  ChevronDown,
  Bell,
  Search,
  LogOut,
  BarChart3,
  Megaphone,
  Flag,
  FileText,
  Layers,
  Sparkles,
  Rss,
  Eye,
} from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';

const sidebarLinks = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/reports', label: 'Reports & Analytics', icon: BarChart3 },
  { href: '/admin/categories', label: 'Categories', icon: Layers },
  { href: '/admin/navigation', label: 'Navigation Menu', icon: Menu },
  { href: '/admin/news', label: 'News Articles', icon: Newspaper },
  { href: '/admin/rss-aggregator', label: 'RSS Aggregator', icon: Rss },
  { href: '/admin/content-generator', label: 'Content Generator', icon: Sparkles },
  { href: '/admin/submissions', label: 'User Submissions', icon: FileText },
  { href: '/admin/moderation', label: 'Content Moderation', icon: Flag },
  { href: '/admin/ads', label: 'Advertisements', icon: Megaphone },
  { href: '/admin/stocks', label: 'Stocks Data', icon: TrendingUp },
  { href: '/admin/broker-stalker', label: 'Broker Stalker', icon: Eye },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-950">
      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 z-50 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 transition-all duration-300 ${
        sidebarOpen ? 'w-64' : 'w-20'
      } ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-gray-200 dark:border-gray-800">
          {sidebarOpen ? (
            <Link href="/admin" className="flex items-center gap-2">
              <div className="w-7 h-7 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-lg flex items-center justify-center">
                <LayoutDashboard className="w-4 h-4 text-white" />
              </div>
              <span className="text-gray-900 dark:text-white font-semibold">Admin</span>
            </Link>
          ) : (
            <Link href="/admin" className="mx-auto">
              <div className="w-8 h-8 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-lg flex items-center justify-center">
                <LayoutDashboard className="w-4 h-4 text-white" />
              </div>
            </Link>
          )}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="lg:hidden p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="p-4 space-y-1">
          {sidebarLinks.map((link) => {
            const isActive = pathname === link.href ||
              (link.href !== '/admin' && pathname.startsWith(link.href));
            const Icon = link.icon;

            return (
              <Link
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
              </Link>
            );
          })}
        </nav>

        {/* Sidebar Toggle (Desktop) */}
        <button
          type="button"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="hidden lg:flex absolute -right-3 top-20 w-6 h-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full items-center justify-center shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${sidebarOpen ? '-rotate-90' : 'rotate-90'}`} />
        </button>

        {/* Back to Site */}
        <div className="absolute bottom-4 left-0 right-0 px-4">
          <Link
            href="/"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${
              !sidebarOpen && 'justify-center'
            }`}
          >
            <LogOut className="w-5 h-5 shrink-0" />
            {sidebarOpen && <span className="font-medium">Back to Site</span>}
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <div className={`transition-all duration-300 ${sidebarOpen ? 'lg:ml-64' : 'lg:ml-20'}`}>
        {/* Top Header */}
        <header className="h-16 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-4 lg:px-6 sticky top-0 z-30">
          {/* Mobile Menu Button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="lg:hidden p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Search */}
          <div className="hidden md:flex items-center gap-2 flex-1 max-w-md">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search..."
                className="w-full pl-10 pr-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button type="button" className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 relative">
              <Bell className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
            </button>
            <div className="flex items-center gap-2 ml-2 pl-2 border-l border-gray-200 dark:border-gray-700">
              <div className="w-8 h-8 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-full flex items-center justify-center text-white font-medium">
                A
              </div>
              <span className="hidden sm:block text-sm font-medium text-gray-900 dark:text-white">Admin</span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
