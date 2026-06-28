export default function SpaceLoading() {
  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0f0f0f]">
      {/* Header skeleton */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0 bg-white/80 dark:bg-[#0f0f0f]/80">
        <div className="flex-1 min-w-0 pl-12 md:pl-0 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-800 shrink-0 animate-pulse" />
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-4 w-28 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
            <div className="h-4 w-14 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="h-7 w-12 rounded-full bg-gray-900 dark:bg-gray-700 animate-pulse" />
          <div className="h-7 w-16 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />
          <div className="h-7 w-12 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />
        </div>
      </div>

      {/* Chat skeleton */}
      <div className="flex-1 overflow-hidden px-4 py-6 max-w-2xl mx-auto w-full">
        <div className="space-y-4 animate-pulse">
          {/* Assistant bubble */}
          <div className="flex justify-start">
            <div className="max-w-[75%] space-y-2">
              <div className="h-3.5 w-56 bg-gray-100 dark:bg-gray-800 rounded-full" />
              <div className="h-3.5 w-72 bg-gray-100 dark:bg-gray-800 rounded-full" />
              <div className="h-3.5 w-48 bg-gray-100 dark:bg-gray-800 rounded-full" />
            </div>
          </div>
          {/* User bubble */}
          <div className="flex justify-end">
            <div className="max-w-[60%] space-y-2">
              <div className="h-3.5 w-44 bg-gray-200 dark:bg-gray-700 rounded-full ml-auto" />
              <div className="h-3.5 w-32 bg-gray-200 dark:bg-gray-700 rounded-full ml-auto" />
            </div>
          </div>
          {/* Assistant bubble */}
          <div className="flex justify-start">
            <div className="max-w-[75%] space-y-2">
              <div className="h-3.5 w-64 bg-gray-100 dark:bg-gray-800 rounded-full" />
              <div className="h-3.5 w-80 bg-gray-100 dark:bg-gray-800 rounded-full" />
              <div className="h-3.5 w-52 bg-gray-100 dark:bg-gray-800 rounded-full" />
              <div className="h-3.5 w-40 bg-gray-100 dark:bg-gray-800 rounded-full" />
            </div>
          </div>
          {/* User bubble */}
          <div className="flex justify-end">
            <div className="max-w-[55%] space-y-2">
              <div className="h-3.5 w-36 bg-gray-200 dark:bg-gray-700 rounded-full ml-auto" />
            </div>
          </div>
        </div>
      </div>

      {/* Input bar skeleton */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t border-gray-100 dark:border-gray-800">
        <div className="h-12 rounded-2xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
      </div>
    </div>
  )
}
