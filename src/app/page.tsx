import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth/config'

export default async function RootPage() {
  const session = await auth()
  if (session) redirect('/spaces')

  return (
    <div className="min-h-dvh bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100">

      {/* ── Nav ── */}
      <nav className="sticky top-0 z-50 bg-white/80 dark:bg-[#0a0a0a]/80 backdrop-blur-md border-b border-gray-100 dark:border-gray-900">
        <div className="max-w-5xl mx-auto px-5 h-14 flex items-center justify-between">
          <span className="text-[15px] font-semibold tracking-tight">Memory</span>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors px-3 py-2"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="text-sm font-medium px-4 py-2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-xl hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors"
            >
              Get started
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="max-w-5xl mx-auto px-5 pt-20 pb-16 text-center">
        <p className="inline-block text-xs font-semibold tracking-widest uppercase text-gray-400 dark:text-gray-500 mb-6 px-3 py-1 border border-gray-200 dark:border-gray-800 rounded-full">
          Executive intelligence
        </p>
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold leading-[1.1] tracking-tight text-gray-900 dark:text-white mb-6" style={{ textWrap: 'balance' }}>
          The memory your
          <br />
          business never had.
        </h1>
        <p className="text-lg sm:text-xl text-gray-500 dark:text-gray-400 max-w-lg mx-auto leading-relaxed mb-10" style={{ textWrap: 'balance' }}>
          Upload documents once. Ask anything forever.
          Understand any project in under two minutes.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/register"
            className="w-full sm:w-auto px-7 py-3.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-semibold rounded-2xl hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors"
          >
            Get started free
          </Link>
          <Link
            href="/login"
            className="w-full sm:w-auto px-7 py-3.5 text-sm font-medium text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-800 rounded-2xl hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
          >
            Sign in →
          </Link>
        </div>
      </section>

      {/* ── Example questions ── */}
      <section className="py-10 border-y border-gray-100 dark:border-gray-900 overflow-hidden">
        <p className="text-center text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 mb-6">
          Ask anything
        </p>
        <div className="flex gap-3 overflow-x-auto px-5 pb-2 scrollbar-hide max-w-5xl mx-auto">
          {[
            '"Brief me on Sea Gardens."',
            '"What changed this week?"',
            '"Why did we make this decision?"',
            '"What are the biggest risks?"',
            '"Prepare me for tomorrow\'s meeting."',
            '"Summarize the latest financials."',
          ].map((q) => (
            <div
              key={q}
              className="shrink-0 px-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap"
            >
              {q}
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section className="max-w-5xl mx-auto px-5 py-20">
        <p className="text-center text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 mb-3">
          Everything you need
        </p>
        <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 dark:text-white mb-12" style={{ textWrap: 'balance' }}>
          Four ways to stay in control
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            {
              icon: '✦',
              title: 'Brief Me',
              desc: 'One tap. Within seconds you understand the project — current status, key numbers, risks, latest decisions.',
            },
            {
              icon: '↻',
              title: 'Catch Me Up',
              desc: 'Everything that changed since your last visit. New documents, decisions, and items that need your attention.',
            },
            {
              icon: '💬',
              title: 'Chat',
              desc: 'Ask anything in plain language. Memory searches across all your documents and answers with full context.',
            },
            {
              icon: '◷',
              title: 'Timeline',
              desc: 'A chronological story of the project — every document, decision, and milestone in one view.',
            },
          ].map((f) => (
            <div
              key={f.title}
              className="p-6 rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50 hover:border-gray-200 dark:hover:border-gray-700 transition-colors"
            >
              <div className="text-2xl mb-4 text-gray-400 dark:text-gray-500">{f.icon}</div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2">{f.title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="border-t border-gray-100 dark:border-gray-900 py-20">
        <div className="max-w-5xl mx-auto px-5">
          <p className="text-center text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 mb-3">
            How it works
          </p>
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 dark:text-white mb-12" style={{ textWrap: 'balance' }}>
            Ready in minutes
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            {[
              {
                step: '01',
                title: 'Create a space',
                desc: 'One space per project — Sea Gardens, Antognolla, Holding Company. Separate context for each.',
              },
              {
                step: '02',
                title: 'Upload documents',
                desc: 'Drop in PDFs, Word docs, Excel files, or add minutes of meeting directly. Memory processes everything automatically.',
              },
              {
                step: '03',
                title: 'Ask anything',
                desc: 'Memory already knows the context. Brief Me, Catch Me Up, or ask any question in plain language.',
              },
            ].map((s) => (
              <div key={s.step} className="flex flex-col gap-3">
                <span className="text-3xl font-bold text-gray-100 dark:text-gray-800 tabular-nums">{s.step}</span>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">{s.title}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Documents supported ── */}
      <section className="border-t border-gray-100 dark:border-gray-900 py-16">
        <div className="max-w-5xl mx-auto px-5 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 mb-6">
            Supports
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {['📄 PDF', '📝 Word', '📊 Excel', '📋 CSV', '✏️ Pasted text'].map((t) => (
              <span
                key={t}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="border-t border-gray-100 dark:border-gray-900 py-24">
        <div className="max-w-2xl mx-auto px-5 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-4 leading-tight" style={{ textWrap: 'balance' }}>
            Know your business.
            <br />
            Before your next meeting.
          </h2>
          <p className="text-gray-500 dark:text-gray-400 mb-8 text-base">
            Free to start. No credit card required.
          </p>
          <Link
            href="/register"
            className="inline-block px-8 py-4 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-semibold rounded-2xl hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors"
          >
            Get started free
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-gray-100 dark:border-gray-900 py-6">
        <div className="max-w-5xl mx-auto px-5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <span className="text-sm font-medium text-gray-900 dark:text-white tracking-tight">Memory</span>
          <div className="flex items-center gap-5">
            <Link href="/login" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
              Sign in
            </Link>
            <Link href="/register" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
              Get started
            </Link>
          </div>
        </div>
      </footer>

    </div>
  )
}
