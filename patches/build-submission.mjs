#!/usr/bin/env node
/**
 * Build the createDiscussion GraphQL payload from the report file.
 * Kept separate from submission so the body is passed as a variable and never
 * round-trips through shell quoting.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const body = readFileSync(process.argv[2], 'utf8')
const payload = {
  query: `mutation Create($repo: ID!, $cat: ID!, $title: String!, $body: String!) {
    createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) {
      discussion { url number title }
    }
  }`,
  variables: {
    repo: process.argv[3],
    cat: process.argv[4],
    title: process.argv[5],
    body,
  },
}
writeFileSync(process.argv[6], JSON.stringify(payload))
console.log(`payload: ${process.argv[6]} (${JSON.stringify(payload).length} bytes)`)
