'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface CustomSynonym {
  key: string
  field: string
  value?: string
  object?: string
  description: string
}

interface GlossaryTerm {
  id: string
  term: string
  mapsTo: string
  explanation: string
}

const OBJECTS = ['Opportunity', 'Case', 'Lead', 'Task', 'Contact', 'Property_Inventory__c', 'Account']

export default function SettingsPage() {
  const [synonyms, setSynonyms] = useState<CustomSynonym[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<CustomSynonym | null>(null)
  const [form, setForm] = useState<CustomSynonym>({ key: '', field: '', value: '', object: 'Opportunity', description: '' })
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  // Business Glossary state — separate from synonyms since it's a different data model
  // (business-term-to-schema mappings, not word-to-field synonyms) and backs the MCP prompt.
  const [glossaryTerms, setGlossaryTerms] = useState<GlossaryTerm[]>([])
  const [glossaryLoading, setGlossaryLoading] = useState(true)
  const [showGlossaryAdd, setShowGlossaryAdd] = useState(false)
  const [glossaryEditing, setGlossaryEditing] = useState<GlossaryTerm | null>(null)
  const [glossaryForm, setGlossaryForm] = useState<{ term: string; mapsTo: string; explanation: string }>({ term: '', mapsTo: '', explanation: '' })
  const [glossaryError, setGlossaryError] = useState('')

  // Skill Files state — free-form instruction documents for MCP prompt
  interface SkillFileItem { id: string; name: string; category: string; triggerWords: string; content: string; active: boolean }
  const [skillFiles, setSkillFiles] = useState<SkillFileItem[]>([])
  const [skillFilesLoading, setSkillFilesLoading] = useState(true)
  const [showSkillAdd, setShowSkillAdd] = useState(false)
  const [skillEditing, setSkillEditing] = useState<SkillFileItem | null>(null)
  const [skillForm, setSkillForm] = useState<{ name: string; category: string; triggerWords: string; content: string; active: boolean }>({ name: '', category: 'general', triggerWords: '', content: '', active: true })
  const [skillError, setSkillError] = useState('')

  const fetchSynonyms = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/synonyms')
      const data = await res.json()
      setSynonyms(data.synonyms || [])
    } catch {
      setError('Failed to load synonyms')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSynonyms() }, [fetchSynonyms])

  const fetchGlossary = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/glossary')
      const data = await res.json()
      setGlossaryTerms(data.terms || [])
    } catch {
      setGlossaryError('Failed to load business glossary')
    } finally {
      setGlossaryLoading(false)
    }
  }, [])

  useEffect(() => { fetchGlossary() }, [fetchGlossary])

  const handleGlossarySave = async () => {
    setGlossaryError('')
    if (!glossaryForm.term.trim() || !glossaryForm.mapsTo.trim()) {
      setGlossaryError('Term and "Maps To" are required')
      return
    }

    const action = glossaryEditing ? 'update' : 'add'
    try {
      const res = await fetch('/api/settings/glossary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, term: { ...glossaryForm, id: glossaryEditing?.id } }),
      })
      const data = await res.json()
      if (!res.ok) {
        setGlossaryError(data.error || 'Failed to save')
        return
      }
      setGlossaryTerms(data.terms)
      setShowGlossaryAdd(false)
      setGlossaryEditing(null)
      setGlossaryForm({ term: '', mapsTo: '', explanation: '' })
    } catch {
      setGlossaryError('Failed to save')
    }
  }

  const handleGlossaryDelete = async (id: string) => {
    try {
      const res = await fetch('/api/settings/glossary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', term: { id } }),
      })
      const data = await res.json()
      setGlossaryTerms(data.terms || [])
    } catch {
      setGlossaryError('Failed to delete')
    }
  }

  const startGlossaryEdit = (t: GlossaryTerm) => {
    setGlossaryEditing(t)
    setGlossaryForm({ term: t.term, mapsTo: t.mapsTo, explanation: t.explanation })
    setShowGlossaryAdd(true)
  }

  // Skill Files handlers
  const fetchSkillFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/skill-files')
      const data = await res.json()
      setSkillFiles(data.files || [])
    } catch {
      setSkillError('Failed to load skill files')
    } finally {
      setSkillFilesLoading(false)
    }
  }, [])

  useEffect(() => { fetchSkillFiles() }, [fetchSkillFiles])

  const handleSkillSave = async () => {
    setSkillError('')
    if (!skillForm.name.trim() || !skillForm.content.trim()) {
      setSkillError('Name and content are required')
      return
    }
    const action = skillEditing ? 'update' : 'add'
    try {
      const res = await fetch('/api/settings/skill-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, file: { ...skillForm, id: skillEditing?.id } }),
      })
      const data = await res.json()
      if (!res.ok) { setSkillError(data.error || 'Failed to save'); return }
      setSkillFiles(data.files)
      setShowSkillAdd(false)
      setSkillEditing(null)
      setSkillForm({ name: '', category: 'general', triggerWords: '', content: '', active: true })
    } catch { setSkillError('Failed to save') }
  }

  const handleSkillDelete = async (id: string) => {
    try {
      const res = await fetch('/api/settings/skill-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', file: { id } }) })
      const data = await res.json()
      setSkillFiles(data.files || [])
    } catch { setSkillError('Failed to delete') }
  }

  const handleSkillToggle = async (f: SkillFileItem) => {
    try {
      const res = await fetch('/api/settings/skill-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update', file: { ...f, active: !f.active } }) })
      const data = await res.json()
      setSkillFiles(data.files || [])
    } catch { setSkillError('Failed to toggle') }
  }

  const handleSkillDeleteAll = async () => {
    if (!confirm('Delete ALL skill files? This cannot be undone.')) return
    try {
      const res = await fetch('/api/settings/skill-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'deleteAll' }) })
      const data = await res.json()
      setSkillFiles(data.files || [])
    } catch { setSkillError('Failed to delete all') }
  }

  const startSkillEdit = (f: SkillFileItem) => {
    setSkillEditing(f)
    setSkillForm({ name: f.name, category: f.category, triggerWords: f.triggerWords || '', content: f.content, active: f.active })
    setShowSkillAdd(true)
  }

  const handleSave = async () => {
    setError('')
    if (!form.key.trim() || !form.field.trim()) {
      setError('Key and field are required')
      return
    }

    const action = editing ? 'update' : 'add'
    try {
      const res = await fetch('/api/settings/synonyms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, synonym: form }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to save')
        return
      }
      setSynonyms(data.synonyms)
      setShowAdd(false)
      setEditing(null)
      setForm({ key: '', field: '', value: '', object: 'Opportunity', description: '' })
    } catch {
      setError('Failed to save')
    }
  }

  const handleDelete = async (key: string) => {
    try {
      const res = await fetch('/api/settings/synonyms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', synonym: { key } }),
      })
      const data = await res.json()
      setSynonyms(data.synonyms || [])
    } catch {
      setError('Failed to delete')
    }
  }

  const startEdit = (s: CustomSynonym) => {
    setEditing(s)
    setForm({ ...s })
    setShowAdd(true)
  }

  const filtered = synonyms.filter(s =>
    s.key.toLowerCase().includes(search.toLowerCase()) ||
    s.field.toLowerCase().includes(search.toLowerCase()) ||
    s.description.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="relative min-h-full overflow-y-auto bg-[radial-gradient(circle_at_50%_0%,#faf9f9_68%,#e2e8f0_100%)] dark:bg-[#0a0a0a] dark:bg-none">
      <div className="w-full max-w-2xl mx-auto px-4 md:px-8 pt-[calc(max(1rem,env(safe-area-inset-top))+5.25rem)] md:pt-10 pb-40 md:pb-16">
        <h1 className="font-sf t-title font-normal text-[#0F172A] dark:text-white mb-6">Settings</h1>

        {/* Business Glossary — how casual business terms map to Salesforce schema.
            This is what backs the MCP/Salesforce answer prompt's terminology understanding. */}
        <div className="rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.02] dark:ring-white/5 p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-figtree text-[17px] font-semibold text-[#0F172A] dark:text-white">Business Glossary</h2>
              <p className="font-sf text-[13px] text-[#94A3B8] dark:text-slate-500 mt-1">
                How business terms map to Salesforce fields/objects. E.g., &quot;Customer&quot; → Account/Contact. Used by the AI when answering questions.
              </p>
            </div>
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={() => { setShowGlossaryAdd(true); setGlossaryEditing(null); setGlossaryForm({ term: '', mapsTo: '', explanation: '' }) }}
              className="px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A] font-sf text-[13px] font-medium shrink-0"
            >
              + Add
            </motion.button>
          </div>

          <AnimatePresence>
            {showGlossaryAdd && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden mb-4"
              >
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 ring-1 ring-black/[0.06] dark:ring-white/10 space-y-3">
                  <div>
                    <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Business Term *</label>
                    <input
                      type="text"
                      placeholder="e.g., Customer, Unit, Sales"
                      value={glossaryForm.term}
                      onChange={e => setGlossaryForm({ ...glossaryForm, term: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Maps To (Object/Field) *</label>
                    <input
                      type="text"
                      placeholder="e.g., Account (via Opportunity.Account.Name)"
                      value={glossaryForm.mapsTo}
                      onChange={e => setGlossaryForm({ ...glossaryForm, mapsTo: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Explanation / When to Apply</label>
                    <textarea
                      placeholder="Explain when and how the AI should use this mapping..."
                      value={glossaryForm.explanation}
                      onChange={e => setGlossaryForm({ ...glossaryForm, explanation: e.target.value })}
                      rows={3}
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white resize-none"
                    />
                  </div>
                  {glossaryError && <p className="font-sf text-[13px] text-red-500">{glossaryError}</p>}
                  <div className="flex gap-2">
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={handleGlossarySave}
                      className="px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A] font-sf text-[13px] font-medium"
                    >
                      {glossaryEditing ? 'Update' : 'Add'}
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => { setShowGlossaryAdd(false); setGlossaryEditing(null); setGlossaryError('') }}
                      className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-white/10 text-[#0F172A] dark:text-white font-sf text-[13px] font-medium"
                    >
                      Cancel
                    </motion.button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {glossaryLoading ? (
            <p className="font-sf text-[14px] text-[#94A3B8] dark:text-slate-500 py-4">Loading...</p>
          ) : glossaryTerms.length === 0 ? (
            <p className="font-sf text-[14px] text-[#94A3B8] dark:text-slate-500 py-4">No glossary terms yet. Click + Add to create one.</p>
          ) : (
            <div className="space-y-2">
              {glossaryTerms.map(t => (
                <motion.div
                  key={t.id}
                  layout
                  className="flex items-start justify-between p-3 rounded-xl bg-slate-50 dark:bg-white/5 ring-1 ring-black/[0.04] dark:ring-white/5"
                >
                  <div className="min-w-0">
                    <span className="font-figtree text-[14px] font-semibold text-[#0F172A] dark:text-white">{t.term}</span>
                    <p className="font-sf text-[12px] text-[#64748B] dark:text-slate-400 mt-0.5">→ {t.mapsTo}</p>
                    {t.explanation && <p className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mt-1">{t.explanation}</p>}
                  </div>
                  <div className="flex gap-1 shrink-0 ml-2">
                    <button
                      onClick={() => startGlossaryEdit(t)}
                      className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-white/10 text-[#94A3B8] dark:text-slate-500"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                    </button>
                    <button
                      onClick={() => handleGlossaryDelete(t.id)}
                      className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-500/10 text-[#94A3B8] dark:text-slate-500 hover:text-red-500"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Skill Files — free-form instruction documents for MCP system prompt */}
        <div className="rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.02] dark:ring-white/5 p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-figtree text-[17px] font-semibold text-[#0F172A] dark:text-white">Skill Files</h2>
              <p className="font-sf text-[13px] text-[#94A3B8] dark:text-slate-500 mt-1">
                Free-form instruction documents injected into the AI prompt. Write detailed business rules, query patterns, or domain knowledge.
              </p>
            </div>
            <motion.button whileTap={{ scale: 0.95 }}
              onClick={() => { setShowSkillAdd(true); setSkillEditing(null); setSkillForm({ name: '', category: 'general', triggerWords: '', content: '', active: true }) }}
              className="px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A] font-sf text-[13px] font-medium shrink-0">
              + Add
            </motion.button>
            {skillFiles.length > 0 && (
              <motion.button whileTap={{ scale: 0.95 }}
                onClick={handleSkillDeleteAll}
                className="px-4 py-2 rounded-xl bg-red-500 text-white font-sf text-[13px] font-medium shrink-0 ml-2">
                Delete All
              </motion.button>
            )}
          </div>

          <AnimatePresence>
            {showSkillAdd && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden mb-4">
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 ring-1 ring-black/[0.06] dark:ring-white/10 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Name *</label>
                      <input type="text" placeholder="e.g., Sales Lookup Rules" value={skillForm.name}
                        onChange={e => setSkillForm({ ...skillForm, name: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white" />
                    </div>
                    <div>
                      <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Category</label>
                      <select value={skillForm.category} onChange={e => setSkillForm({ ...skillForm, category: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white">
                        <option value="general">General</option>
                        <option value="sales">Sales</option>
                        <option value="property">Property</option>
                        <option value="ownership">Ownership</option>
                        <option value="pricing">Pricing</option>
                        <option value="reporting">Reporting</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Trigger Words (comma-separated)</label>
                    <input type="text" placeholder="e.g., owner, buyer, customer, who bought" value={skillForm.triggerWords}
                      onChange={e => setSkillForm({ ...skillForm, triggerWords: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white" />
                    <p className="font-sf text-[11px] text-[#94A3B8] dark:text-slate-500 mt-1">Keywords that trigger loading this skill. Leave empty to load only when category matches.</p>
                  </div>
                  <div>
                    <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Instructions *</label>
                    <textarea placeholder={"Write detailed instructions for the AI. Examples:\n- When asking about unit owners, always query Opportunity WHERE IsWon=true, then get Account.Name\n- For year comparisons, use Order_Date__c, NOT CloseDate\n- Safi Townhouses unit codes are formatted as 'TS SAF TH-V-6'"} value={skillForm.content}
                      onChange={e => setSkillForm({ ...skillForm, content: e.target.value })} rows={6}
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white resize-y" />
                  </div>
                  {skillError && <p className="font-sf text-[13px] text-red-500">{skillError}</p>}
                  <div className="flex gap-2">
                    <motion.button whileTap={{ scale: 0.95 }} onClick={handleSkillSave}
                      className="px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A] font-sf text-[13px] font-medium">
                      {skillEditing ? 'Update' : 'Add'}
                    </motion.button>
                    <motion.button whileTap={{ scale: 0.95 }}
                      onClick={() => { setShowSkillAdd(false); setSkillEditing(null); setSkillError('') }}
                      className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-white/10 text-[#0F172A] dark:text-white font-sf text-[13px] font-medium">
                      Cancel
                    </motion.button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {skillFilesLoading ? (
            <p className="font-sf text-[14px] text-[#94A3B8] dark:text-slate-500 py-4">Loading...</p>
          ) : skillFiles.length === 0 ? (
            <p className="font-sf text-[14px] text-[#94A3B8] dark:text-slate-500 py-4">No skill files yet. Click + Add to create one.</p>
          ) : (
            <div className="space-y-2">
              {skillFiles.map(f => (
                <motion.div key={f.id} layout className="p-3 rounded-xl bg-slate-50 dark:bg-white/5 ring-1 ring-black/[0.04] dark:ring-white/5">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-figtree text-[14px] font-semibold text-[#0F172A] dark:text-white">{f.name}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-white/10 text-[#64748B] dark:text-slate-400">{f.category}</span>
                        {!f.active && <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-500/10 text-red-500">disabled</span>}
                      </div>
                      <p className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mt-1 line-clamp-3 whitespace-pre-wrap">{f.content}</p>
                    </div>
                    <div className="flex gap-1 shrink-0 ml-2">
                      <button onClick={() => handleSkillToggle(f)} title={f.active ? 'Disable' : 'Enable'}
                        className={`p-1.5 rounded-lg ${f.active ? 'hover:bg-slate-200 dark:hover:bg-white/10 text-green-500' : 'hover:bg-slate-200 dark:hover:bg-white/10 text-[#94A3B8] dark:text-slate-500'}`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      </button>
                      <button onClick={() => startSkillEdit(f)} className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-white/10 text-[#94A3B8] dark:text-slate-500">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                      <button onClick={() => handleSkillDelete(f.id)} className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-500/10 text-[#94A3B8] dark:text-slate-500 hover:text-red-500">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Synonym Management */}
        <div className="rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.02] dark:ring-white/5 p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-figtree text-[17px] font-semibold text-[#0F172A] dark:text-white">Synonyms</h2>
              <p className="font-sf text-[13px] text-[#94A3B8] dark:text-slate-500 mt-1">
                Map similar words to CRM fields. E.g., "home" → Building_Name__c
              </p>
            </div>
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={() => { setShowAdd(true); setEditing(null); setForm({ key: '', field: '', value: '', object: 'Opportunity', description: '' }) }}
              className="px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A] font-sf text-[13px] font-medium"
            >
              + Add
            </motion.button>
          </div>

          {/* Search */}
          <input
            type="text"
            placeholder="Search synonyms..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-white/5 ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white placeholder:text-[#94A3B8] dark:placeholder:text-slate-600 mb-4"
          />

          {/* Add/Edit Form */}
          <AnimatePresence>
            {showAdd && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden mb-4"
              >
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 ring-1 ring-black/[0.06] dark:ring-white/10 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Word/Phrase *</label>
                      <input
                        type="text"
                        placeholder="e.g., home, villa type"
                        value={form.key}
                        onChange={e => setForm({ ...form, key: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">CRM Field *</label>
                      <input
                        type="text"
                        placeholder="e.g., Building_Name__c"
                        value={form.field}
                        onChange={e => setForm({ ...form, field: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Value (optional)</label>
                      <input
                        type="text"
                        placeholder="e.g., Hayat Townhouses"
                        value={form.value || ''}
                        onChange={e => setForm({ ...form, value: e.target.value || undefined })}
                        className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Object</label>
                      <select
                        value={form.object || 'Opportunity'}
                        onChange={e => setForm({ ...form, object: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white"
                      >
                        {OBJECTS.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mb-1 block">Description</label>
                    <input
                      type="text"
                      placeholder="What this synonym maps to"
                      value={form.description}
                      onChange={e => setForm({ ...form, description: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] ring-1 ring-black/[0.06] dark:ring-white/10 font-sf text-[14px] text-[#0F172A] dark:text-white"
                    />
                  </div>
                  {error && <p className="font-sf text-[13px] text-red-500">{error}</p>}
                  <div className="flex gap-2">
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={handleSave}
                      className="px-4 py-2 rounded-xl bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A] font-sf text-[13px] font-medium"
                    >
                      {editing ? 'Update' : 'Add'}
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => { setShowAdd(false); setEditing(null); setError('') }}
                      className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-white/10 text-[#0F172A] dark:text-white font-sf text-[13px] font-medium"
                    >
                      Cancel
                    </motion.button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Synonyms List */}
          {loading ? (
            <p className="font-sf text-[14px] text-[#94A3B8] dark:text-slate-500 py-4">Loading...</p>
          ) : filtered.length === 0 ? (
            <p className="font-sf text-[14px] text-[#94A3B8] dark:text-slate-500 py-4">
              {search ? 'No synonyms match your search' : 'No custom synonyms yet. Click + Add to create one.'}
            </p>
          ) : (
            <div className="space-y-2">
              {filtered.map(s => (
                <motion.div
                  key={s.key}
                  layout
                  className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-white/5 ring-1 ring-black/[0.04] dark:ring-white/5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-figtree text-[14px] font-semibold text-[#0F172A] dark:text-white">{s.key}</span>
                      <span className="font-sf text-[11px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-white/10 text-[#64748B] dark:text-slate-400">{s.object || 'Opportunity'}</span>
                    </div>
                    <p className="font-sf text-[12px] text-[#94A3B8] dark:text-slate-500 mt-0.5">
                      → {s.field}{s.value ? ` = "${s.value}"` : ''} {s.description ? `(${s.description})` : ''}
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0 ml-2">
                    <button
                      onClick={() => startEdit(s)}
                      className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-white/10 text-[#94A3B8] dark:text-slate-500"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                    </button>
                    <button
                      onClick={() => handleDelete(s.key)}
                      className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-500/10 text-[#94A3B8] dark:text-slate-500 hover:text-red-500"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Info card */}
        <div className="rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.02] dark:ring-white/5 p-5">
          <h2 className="font-figtree text-[17px] font-semibold text-[#0F172A] dark:text-white mb-2">Built-in Synonyms</h2>
          <p className="font-sf text-[13px] text-[#94A3B8] dark:text-slate-500 mb-3">
            The system has 100+ built-in synonyms for common CRM terms. Custom synonyms above will be prioritized.
          </p>
          <div className="flex flex-wrap gap-2">
            {['community', 'bedroom', 'salesperson', 'pipeline', 'won', 'lost', 'cancelled', 'mortgage', 'handover', 'agency'].map(term => (
              <span key={term} className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/5 font-sf text-[12px] text-[#64748B] dark:text-slate-400">
                {term}
              </span>
            ))}
            <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/5 font-sf text-[12px] text-[#94A3B8] dark:text-slate-500">
              + 90 more
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}