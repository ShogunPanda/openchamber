import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { mergeMessages } from "./optimistic"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export type MaterializedMessageRecord = {
  info: Message
  parts: Part[]
}

export type MaterializedState = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

export type MaterializeSessionSnapshotsOptions = {
  skipPartTypes?: ReadonlySet<string>
  mode?: "merge" | "prepend"
}

export type MaterializeSessionSnapshotsResult = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  messages: Message[]
  messagesChanged: boolean
  partsChanged: boolean
}

export type SessionMaterializationStatus = {
  hasMessages: boolean
  renderable: boolean
  missingPartMessageIDs: string[]
}

function sortParts(parts: Part[], skipPartTypes: ReadonlySet<string>) {
  return parts
    .filter((part) => !!part?.id && !skipPartTypes.has(part.type))
    .sort((a, b) => cmp(a.id, b.id))
}

function haveEquivalentPartSnapshots(left: Part[] | undefined, right: Part[]): boolean {
  if (!left) return right.length === 0
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (!leftPart || !rightPart) return false
    if (leftPart.id !== rightPart.id) return false
    if (JSON.stringify(leftPart) !== JSON.stringify(rightPart)) return false
  }

  return true
}

export function materializeSessionSnapshots(
  state: MaterializedState,
  sessionID: string,
  records: MaterializedMessageRecord[],
  options: MaterializeSessionSnapshotsOptions = {},
): MaterializeSessionSnapshotsResult {
  const skipPartTypes = options.skipPartTypes ?? new Set<string>()
  const snapshots = records
    .filter((record) => !!record?.info?.id)
    .sort((left, right) => cmp(left.info.id, right.info.id))
  const nextMessages = snapshots.map((record) => record.info)
  const currentMessages = state.message[sessionID] ?? []
  const messages = mergeMessages(currentMessages, nextMessages)
  const messagesChanged = messages !== currentMessages

  let partsChanged = false
  const nextPartState = { ...state.part }
  const isPrepend = options.mode === "prepend"

  for (const record of snapshots) {
    const messageID = record.info.id
    if (isPrepend && nextPartState[messageID]) continue

    const nextParts = sortParts(record.parts ?? [], skipPartTypes)
    const existing = nextPartState[messageID]
    if (haveEquivalentPartSnapshots(existing, nextParts)) continue

    if (nextParts.length === 0) {
      delete nextPartState[messageID]
    } else {
      nextPartState[messageID] = nextParts
    }
    partsChanged = true
  }

  return {
    message: messagesChanged ? { ...state.message, [sessionID]: messages } : state.message,
    part: partsChanged ? nextPartState : state.part,
    messages,
    messagesChanged,
    partsChanged,
  }
}

export function getSessionMaterializationStatus(
  state: MaterializedState,
  sessionID: string,
): SessionMaterializationStatus {
  const messages = state.message[sessionID]
  if (!messages) {
    return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  }

  const missingPartMessageIDs: string[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const parts = state.part[message.id]
    if (!parts || parts.length === 0) {
      missingPartMessageIDs.push(message.id)
    }
  }

  return {
    hasMessages: true,
    renderable: missingPartMessageIDs.length === 0,
    missingPartMessageIDs,
  }
}
