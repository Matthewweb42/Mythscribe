import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FEATURE_BUDGETS, FEATURE_INPUT_BUDGETS } from '@shared/ai'
import { isPromptVersion, PROMPT_CATALOGUE, PROMPT_VERSIONS } from './catalogue'

/** Every prompt module in this directory, keyed by its path, loaded eagerly. */
const modules = import.meta.glob<Record<string, unknown>>(['./*.v*.ts', '!./*.test.ts'], {
  eager: true
})

const versionOf = (file: string): string => path.basename(file, '.ts')

describe('prompt catalogue (F-5.12)', () => {
  it('lists exactly the <feature>.v<N>.ts files in src/main/ai/prompts', () => {
    const onDisk = fs
      .readdirSync(import.meta.dirname)
      .filter((file) => /^[a-zA-Z]+\.v\d+\.ts$/.test(file))
      .map(versionOf)
      .sort()
    expect([...PROMPT_VERSIONS].sort()).toEqual(onDisk)
  })

  it('each prompt module exports its own version string equal to its file name', () => {
    for (const [file, mod] of Object.entries(modules)) {
      const version = versionOf(file)
      expect(
        Object.values(mod),
        `${file} must export a *_PROMPT_VERSION of '${version}'`
      ).toContain(version)
    }
  })

  it("every catalogued feature has its budget lines, so the harness's headroom is the real cap", () => {
    for (const version of PROMPT_VERSIONS) {
      const { feature } = PROMPT_CATALOGUE[version]
      expect(FEATURE_BUDGETS[feature], `${feature} needs a FEATURE_BUDGETS line`).toBeDefined()
      expect(
        FEATURE_INPUT_BUDGETS[feature],
        `${feature} needs a FEATURE_INPUT_BUDGETS line`
      ).toBeDefined()
    }
  })

  it('isPromptVersion recognises catalogued versions only', () => {
    expect(isPromptVersion('tags.v1')).toBe(true)
    expect(isPromptVersion('tags.v9')).toBe(false)
    expect(isPromptVersion('')).toBe(false)
  })
})
