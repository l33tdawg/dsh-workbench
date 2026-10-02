/**
 * The log-reading half of the compaction-todo plugin, with no harness imports.
 *
 * These functions answer three questions about one session's durable log: what
 * is the newest todo list, when was the context last compacted, and does the
 * list need putting back. Keeping them here rather than in `index.ts` is what
 * lets them be tested directly — `index.ts` imports the harness's message
 * constructor, which only resolves inside a running DSH installation.
 *
 * @module @l33tdawg/dsh-compaction-todo/log
 */

/** One todo as `todo_write` stores it. */
export interface StoredTodo {
  readonly content: string
  readonly status: string
}

/** The minimal session surface these functions read. */
export interface SessionLike {
  readonly seq: number
  eventAt(index: number): { readonly type?: string; readonly seq?: number; readonly data?: unknown } | undefined
}

/** What a backwards scan of the log found. */
export interface LogState {
  /** The newest usable todo list, absent when the log holds none. */
  readonly todos?: readonly StoredTodo[]
  /** Sequence of that `todo/write` event. */
  readonly wroteAt?: number
  /** Sequence of the newest `compaction/end`, absent when none has happened. */
  readonly compactedAt?: number
}

/**
 * Read one `todo/write` payload, or undefined when the record is not usable.
 *
 * A resumed, forked, or externally written seed can carry a shape this plugin
 * does not recognise. Treating that as "not a todo list" keeps one unreadable
 * record from throwing inside a step listener and failing every later turn.
 *
 * @param data - the event's `data` field.
 * @returns the parsed list, or undefined.
 */
export function readTodos(data: unknown): readonly StoredTodo[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const todos = (data as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return undefined
  const readable: StoredTodo[] = []
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) return undefined
    const { content, status } = todo as { content?: unknown; status?: unknown }
    if (typeof content !== 'string' || typeof status !== 'string') return undefined
    readable.push({ content, status })
  }
  return readable
}

/**
 * Walk the durable log backwards for the newest todo list and the newest
 * compaction boundary.
 *
 * @param session - the live session to read.
 * @returns the newest list, when it was written, and when the context was last
 *   compacted.
 */
export function scanLog(session: SessionLike): LogState {
  let todos: readonly StoredTodo[] | undefined
  let wroteAt: number | undefined
  let compactedAt: number | undefined

  for (let index = session.seq - 1; index >= 0; index -= 1) {
    const event = session.eventAt(index)
    if (event === undefined) continue
    const seq = typeof event.seq === 'number' ? event.seq : index
    if (compactedAt === undefined && event.type === 'compaction/end') compactedAt = seq
    if (todos === undefined && event.type === 'todo/write') {
      const parsed = readTodos(event.data)
      if (parsed !== undefined) {
        todos = parsed
        wroteAt = seq
      }
    }
    if (compactedAt !== undefined && wroteAt !== undefined) break
  }

  return wroteAt === undefined ? { compactedAt } : { todos: todos ?? [], wroteAt, compactedAt }
}

/**
 * Whether the newest list should be put back.
 *
 * A compaction older than the newest write is not a reason to remind: the agent
 * has written its plan since, so the plan it is working from is already in
 * context. An empty newest list is not a reason either — an agent that clears
 * its list has finished, and reminding it about nothing is noise.
 *
 * @param state - the log scan.
 * @returns true when a compaction happened after the newest non-empty todo write.
 */
export function needsReminder(state: LogState): boolean {
  if (state.compactedAt === undefined || state.wroteAt === undefined) return false
  if (state.compactedAt <= state.wroteAt) return false
  return (state.todos?.length ?? 0) > 0
}

/**
 * Escape the angle brackets in text this plugin replays.
 *
 * The reminder is framed by `<system-reminder>` tags, and a todo's text is
 * model- and user-authored. A todo containing those tags would close the frame
 * early and let the rest of the list read as prompt text outside it. Escaping is
 * not a substitute for treating that text as data — it only keeps the frame
 * intact.
 *
 * @param text - the raw text.
 * @returns the text with `<` and `>` escaped.
 */
export function escapeText(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Render the reminder the model reads after a compaction.
 * @param todos - the list to replay.
 * @returns the message text.
 */
export function renderReminder(todos: readonly StoredTodo[]): string {
  const counted = (status: string) => todos.filter(todo => todo.status === status).length
  const mark = (status: string) => (status === 'in_progress' ? '~' : status === 'completed' ? 'x' : ' ')
  return [
    '<system-reminder>',
    'Your context was compacted, which replaced the tool results this task list came from.',
    'This is the list as of your most recent todo_write, replayed from the session log:',
    '',
    ...todos.map(todo => `- [${mark(todo.status)}] ${escapeText(todo.content)}`),
    '',
    `(${counted('pending')} pending, ${counted('in_progress')} in progress, ${counted('completed')} completed.)`,
    'Continue from this list, and call todo_write again when it changes.',
    '</system-reminder>',
  ].join('\n')
}
