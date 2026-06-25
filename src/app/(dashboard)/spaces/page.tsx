'use client'

import { motion } from 'framer-motion'

export default function SpacesWelcomePage() {
  return (
    <div className="flex h-full items-center justify-center bg-white dark:bg-[#0f0f0f]">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="text-center px-6"
      >
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 300, damping: 24 }}
          className="text-4xl sm:text-5xl mb-5 select-none"
        >
          💭
        </motion.div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          Select a space
        </h2>
        <p className="text-sm text-gray-400 dark:text-gray-500 max-w-xs mx-auto leading-relaxed">
          <span className="md:hidden">Tap ☰ to open your spaces, or create a new one.</span>
          <span className="hidden md:inline">Choose a space from the sidebar to start chatting, or create a new one.</span>
        </p>
      </motion.div>
    </div>
  )
}
