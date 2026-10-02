#!/usr/bin/env node
/**
 * Post one comment to a GitHub Discussion, body passed as a GraphQL variable.
 *
 * The body never round-trips through shell quoting: it is read from a file and
 * carried in the JSON payload on stdin, the same shape `build-submission.mjs`
 * uses for discussion creation. Prints the resulting comment URL, or the raw
 * GraphQL error.
 *
 * Usage:
 *   node post-discussion-comment.mjs <discussionNodeId> <bodyFile> <payloadOut>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [, , discussionId, bodyFile, payloadOut] = process.argv
if (discussionId === undefined || bodyFile === undefined || payloadOut === undefined) {
  console.error('usage: node post-discussion-comment.mjs <discussionNodeId> <bodyFile> <payloadOut>')
  process.exit(2)
}

const body = readFileSync(bodyFile, 'utf8')
const payload = {
  query: `mutation Comment($discussionId: ID!, $body: String!) {
    addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
      comment { url createdAt }
    }
  }`,
  variables: { discussionId, body },
}
writeFileSync(payloadOut, JSON.stringify(payload))
console.log(`payload: ${payloadOut} (${JSON.stringify(payload).length} bytes)`)
