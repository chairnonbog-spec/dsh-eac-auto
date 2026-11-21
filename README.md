# EAC Auto

[![npm](https://img.shields.io/npm/v/dsh-eac-auto.svg)](https://www.npmjs.com/package/dsh-eac-auto)
[![license](https://img.shields.io/npm/l/dsh-eac-auto.svg)](LICENSE)

> **安装**：`dsh plugin add dsh-eac-auto`
> 或在 DSH 的 **Plugins** → **Add plugin** 中填入包名。装完重启 DSH。
>
> 需要先安装并登录 **`dsh-our-free-model`**（EAC 通道由它提供）。

Adds one selectable model, **EAC AUTO**, to DeepSeek Harness.

EAC AUTO is not a model of its own. It is a *virtual* model that answers from
the free EAC (co-paid) models exposed by the `dsh-our-free-model` plugin, and
**switches to the next model automatically whenever one fails** — so a quota
wall, an expired upstream or a 5xx no longer ends your turn.

## What it does

1. **Reads the EAC roster.** The plugin discovers the co-paid lane's free
   models from the lane itself (`dsh-our-free-model`), so "EAC AUTO" can never
   offer a model the lane would refuse. When the lane is not mounted yet, the
   lane's own persisted catalog answers instead.
2. **Offers one model.** The model picker shows a single entry, `EAC AUTO`,
   under its own group. Nothing else changes.
3. **Fails over.** Each turn walks the roster in order. The first candidate
   that produces an answer wins. A candidate that errors, times out or returns
   nothing is discarded *whole* and the next one is tried — the user sees one
   continuous answer, never a half-written one.

## Requirements

`dsh-our-free-model` must be installed and signed in, so the EAC lane offers
its models. Without it the roster is empty and `EAC AUTO` reports that plainly
rather than failing mysteriously.

## Configuration

The plugin's row in `cordis.patch.yml` accepts:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether `EAC AUTO` is offered at all. |
| `strategy` | `balanced` | Failover order: `balanced` (the lane's own order), `speed` (largest output ceiling first) or `quality` (largest context window first). |
| `preferredModels` | `[]` | Model ids to put at the head of the roster, in your order. |
| `excludedModels` | `[]` | Model ids to keep out of the roster entirely. |
| `silenceTimeoutMs` | `120000` | How long a candidate may stay silent before it counts as failed. |

Example:

```yaml
- insert:
    - id: eac-auto
      name: 'dsh-eac-auto'
      config:
        strategy: quality
        preferredModels:
          - deepseek-ai/deepseek-v4.1-flash
        excludedModels:
          - openai/gpt-oss-20b
        silenceTimeoutMs: 180000
```

Every value is validated by the plugin itself, so a typo falls back to the
default rather than failing the row. The plugin exports **no** `Config` schema
on purpose: a schema is validated through `@deepseek-ai/schemastery`, which a
profile plugin cannot import from the host installation without adding a
dependency the profile's tree does not own — and a plugin whose schema cannot
be imported does not activate at all.

## Status

The plugin exposes a small read-only surface for inspecting the roster:

- `GET /api/eac-auto/status` — the current roster, its source, and the attempt
  trail of the most recent turn.
- `POST /api/eac-auto/refresh` — re-read the roster from the lane now.

## How it is built

The plugin never holds a credential, opens a socket or speaks a provider
protocol. The real turn is dispatched by `dsh-our-free-model`'s own adapter
through the `llm` service, under the lane's provider route. Everything this
plugin does is *selection*.

The failover rule follows the one that makes a switch invisible: a candidate is
committed only once it produces an answer-bearing delta. Until then its chunks
are buffered and thrown away whole, so a discarded attempt never reaches the
transcript. Reasoning deltas are deliberately not a commit — "thought for a
minute, then hit a quota wall" is the most valuable case to fail over.

## Licence

MIT.
