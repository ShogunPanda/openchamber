import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "../materialization"

function message(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 } } as Message
}

function part(id: string, messageID: string, type = "text"): Part {
  return { id, messageID, sessionID: "ses_1", type, text: id } as Part
}

describe("materializeSessionSnapshots", () => {
  test("materializes messages and parts together", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_1", "msg_1")] }],
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.messagesChanged).toBe(true)
    expect(result.partsChanged).toBe(true)
  })

  test("preserves unchanged references", () => {
    const existingMessage = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state = { message: { ses_1: [existingMessage] }, part: { msg_1: [existingPart] } }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: existingMessage, parts: [existingPart] }],
    )

    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
    expect(result.messagesChanged).toBe(false)
    expect(result.partsChanged).toBe(false)
  })

  test("skips non-rendered part types", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_patch", "msg_1", "patch"), part("prt_text", "msg_1")] }],
      { skipPartTypes: new Set(["patch"]) },
    )

    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_text"])
  })
})

describe("getSessionMaterializationStatus", () => {
  test("requires assistant parts for renderable cached state", () => {
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: false,
      missingPartMessageIDs: ["msg_1"],
    })
  })

  test("treats user-only cached state as renderable", () => {
    const state = {
      message: { ses_1: [{ ...message("msg_1"), role: "user" } as Message] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })
})
