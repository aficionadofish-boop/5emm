import { CR } from 'src/data/CR'
import { useMonsterStore } from 'src/stores/monster-store'
import { useI18n } from 'vue-i18n'
import N2W from 'number-to-words'
import { DndAttack, DndStat } from '../models'
import {
  avgRoll,
  bonusForSkill,
  renderBonus,
  saveModifierForStat,
} from './mathRendering'
import { useProcessTokens } from './useProcessTokens'
import { useTextRenderer } from './useTextRenderer'
import SPELL_SOURCES from 'src/data/5etools-spells.json'

// 5etools homebrew JSON (https://5e.tools), shaped so the 5etools Roll20 extension
// (betteR20, "Import Monsters From File") imports it like an official monster.
// betteR20 builds attack rows by matching the rendered text, e.g.
// "Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 7 (1d8 + 3) slashing damage."
// (betterR20 js/5etools-importer.js, _baseAddAction), so attacks are written in exactly
// that form with 5etools tags, and at most two damage parts are rollable.

export const SOURCE = {
  json: 'MonsterMakerHomebrew',
  abbreviation: 'HB',
  full: "Homebrew (Falindrith's Monster Maker)",
}

const SIZE_CODE: Record<string, string> = {
  Tiny: 'T',
  Small: 'S',
  Medium: 'M',
  Large: 'L',
  Huge: 'H',
  Gargantuan: 'G',
}

const ALIGNMENT_CODE: Record<string, string[]> = {
  unaligned: ['U'],
  'lawful good': ['L', 'G'],
  'neutral good': ['N', 'G'],
  'chaotic good': ['C', 'G'],
  'lawful neutral': ['L', 'N'],
  neutral: ['N'],
  'chaotic neutral': ['C', 'N'],
  'lawful evil': ['L', 'E'],
  'neutral evil': ['N', 'E'],
  'chaotic evil': ['C', 'E'],
  'any alignment': ['A'],
}

const ATTACK_CODE = {
  MELEE: { WEAPON: 'mw', SPELL: 'ms' },
  RANGED: { WEAPON: 'rw', SPELL: 'rs' },
  BOTH: { WEAPON: 'mw,rw', SPELL: 'ms,rs' },
}

const spellSources = SPELL_SOURCES as Record<string, string>

// a 5etools entry: a string, or a block such as a list
type Entry = string | { type: string; items: string[] }
interface Named {
  name: string
  entries: Entry[]
}

// "1d8 + 3" with spaces, as the books print it
function diceText(count: number, dice: number, modifier: number) {
  const mod =
    modifier === 0 ? '' : ` ${modifier < 0 ? '-' : '+'} ${Math.abs(modifier)}`
  return `${count}d${dice}${mod}`
}

// "7 ({@damage 1d8 + 3}) slashing damage"; a flat amount when there are no dice
function damageText(count: number, dice: number, modifier: number, type: string) {
  const avg = Math.max(1, avgRoll(count, dice) + modifier)
  if (count === 0 || dice <= 1) return `${avg} ${type} damage`
  return `${avg} ({@damage ${diceText(count, dice, modifier)}}) ${type} damage`
}

export function spellTag(name: string) {
  const source = spellSources[name.trim().toLowerCase()]
  if (source == null) return name // a custom spell: 5etools can't look it up
  return `{@spell ${name.trim().toLowerCase()}${source === 'PHB' ? '' : `|${source}`}}`
}

// the maker's rendered HTML (b/i/u, div line breaks) -> 5etools entries, with dice and
// save DCs tagged so 5etools rolls them
export function toEntries(html: string): string[] {
  const paragraphs = html
    .replace(/&nbsp;/gi, ' ')
    .split(/<div><br><\/div>|<br\s*\/?>/gi)
    .map((p) =>
      p
        .replace(/<\/?div>/gi, ' ')
        .replace(/<\/?u>/gi, '')
        .replace(/<b>(.*?)<\/b>/gi, '{@b $1}')
        .replace(/<i>(.*?)<\/i>/gi, '{@i $1}')
        .replace(/<\/?[bi]>/gi, '')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((p) => p !== '')

  return paragraphs.map((p) =>
    p
      .replace(
        /(\d+) \((\d+d\d+)\s*(?:([+-])\s*(\d+))?\)( (?:\S+ )?damage)?/g,
        (match, avg, dice, sign, mod, damage) => {
          const expr = sign ? `${dice} ${sign} ${mod}` : dice
          return damage
            ? `${avg} ({@damage ${expr}})${damage}`
            : `${avg} ({@dice ${expr}})`
        }
      )
      .replace(/\bDC (\d+)\b/g, '{@dc $1}')
  )
}

// the maker renders "<b><i>Name (Recharge 5-6).</i></b> text": split off that header
export function splitHeader(html: string, fallbackName: string): Named {
  const m = html.match(/^\s*(?:<[bi]>){2}(.*?)(?:<\/[bi]>){2}\s*/i)
  if (!m) return { name: fallbackName, entries: toEntries(html) }
  const name = m[1].replace(/<\/?[a-z]+>/gi, '').replace(/\.\s*$/, '').trim()
  return { name, entries: toEntries(html.slice(m[0].length)) }
}

export function use5etoolsRenderer() {
  const monster = useMonsterStore()
  const renderer = useTextRenderer()
  const {
    processTokens,
    processTrait,
    processAction,
    processReaction,
    processMultiattack,
    processLegendaryAction,
    processAttack,
  } = useProcessTokens()
  const { t } = useI18n()

  const renderAttack = (attack: DndAttack): Named => {
    if (attack.useCustomRenderer) {
      return splitHeader(processAttack(attack, monster), attack.name)
    }

    // older saves hold 'Melee' / 'Melee or Ranged' / 'Weapon'
    const distance = (
      /or/i.test(attack.distance) ? 'BOTH' : attack.distance.toUpperCase()
    ) as DndAttack['distance']
    const kind = attack.kind.toUpperCase() as DndAttack['kind']

    const range =
      distance === 'MELEE'
        ? `reach ${attack.range.reach} ft.`
        : distance === 'RANGED'
        ? `range ${attack.range.standard}/${attack.range.long} ft.`
        : `reach ${attack.range.reach} ft. or range ${attack.range.standard}/${attack.range.long} ft.`
    const targets =
      attack.targets === 1 ? 'one target' : `${N2W.toWords(attack.targets)} targets`

    let hit = damageText(
      attack.damage.count,
      attack.damage.dice,
      monster.attackDamageModifier(attack.id),
      attack.damage.type
    )
    // additional damage first: betteR20 rolls the first two damage parts it finds
    for (const d of attack.additionalDamage) {
      hit += ` plus ${damageText(d.count, d.dice, 0, d.type)}${
        d.note ? ` ${d.note}` : ''
      }`
    }
    if (attack.alternateDamage.active) {
      hit += `, or ${damageText(
        attack.alternateDamage.count,
        attack.alternateDamage.dice,
        monster.conditionalDamageModifier(attack.id),
        attack.alternateDamage.type
      )} ${attack.alternateDamage.condition}`.trimEnd()
    }

    const description = attack.description
      ? ` ${toEntries(
          processTokens(attack.description, attack, monster, 'attack')
        ).join(' ')}`
      : ''

    return {
      name: attack.name,
      entries: [
        `{@atk ${ATTACK_CODE[distance][kind]}} {@hit ${monster.attackModifier(
          attack.id
        )}} to hit, ${range}, ${targets}. {@h}${hit}.${description}`,
      ],
    }
  }

  const renderSpellcasting = () => {
    const sc = monster.spellcasting
    const blocks = []
    const ability = sc.stat.toLowerCase()

    if (sc.standard.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spells: Record<string, any> = {}
      const cantrips = monster.knownSpellsOfLevel(0)
      if (cantrips.length > 0) spells['0'] = { spells: cantrips.map(spellTag) }
      for (const slot of monster.spellsBySlot) {
        spells[`${slot.level}`] = {
          slots: slot.slots,
          spells: slot.spells.map(spellTag),
        }
      }

      // the preamble starts with its own "<b><i>Spellcasting.</i></b>" header
      const { name, entries } = splitHeader(
        renderer.classSpellcastingPreamble.value,
        'Spellcasting'
      )
      blocks.push({
        name,
        type: 'spellcasting',
        headerEntries: entries,
        spells,
        ...(sc.notes ? { footerEntries: toEntries(sc.notes) } : {}),
        ability,
      })
    }

    if (sc.atWill.length > 0) {
      const will: string[] = []
      const daily: Record<string, string[]> = {}
      const rest: Record<string, string[]> = {}
      for (const list of sc.atWill) {
        const tagged = list.spells.map(spellTag)
        if (list.rate === 'AT_WILL') will.push(...tagged)
        else if (list.rate === 'DAY') daily[`${list.count}`] = tagged
        else if (list.rate === 'DAY_EACH') daily[`${list.count}e`] = tagged
        else rest[`${list.count}`] = tagged
      }

      const { name, entries } = splitHeader(
        renderer.innateSpellcastingPreamble.value,
        'Innate Spellcasting'
      )
      blocks.push({
        name,
        type: 'spellcasting',
        headerEntries: entries,
        ...(will.length ? { will } : {}),
        ...(Object.keys(daily).length ? { daily } : {}),
        ...(Object.keys(rest).length ? { rest } : {}),
        ...(sc.atWillNotes ? { footerEntries: toEntries(sc.atWillNotes) } : {}),
        ability,
      })
    }

    return blocks
  }

  const render5etoolsJson = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = {
      name: monster.name,
      source: SOURCE.json,
      page: 0,
      size: [SIZE_CODE[monster.size] ?? 'M'],
    }

    // "humanoid (elf, wizard)" -> {type, tags}
    const type = (monster.type ?? '').trim()
    const typeMatch = type.match(/^([^(]+?)\s*\((.*)\)$/)
    m.type = typeMatch
      ? {
          type: typeMatch[1].toLowerCase(),
          tags: typeMatch[2].split(',').map((s) => s.trim()),
        }
      : type.toLowerCase()

    const alignment = (monster.alignment ?? '').trim().toLowerCase()
    m.alignment = ALIGNMENT_CODE[alignment] ?? [{ special: monster.alignment }]

    m.ac = monster.ACType
      ? [{ ac: monster.AC, from: [monster.ACType] }]
      : [monster.AC]
    m.hp = {
      average: monster.avgHp,
      formula: diceText(monster.HP.HD, monster.HP.type, monster.HP.modifier),
    }

    m.speed = {}
    for (const s of monster.speeds) {
      const kind = (s.type ?? 'walk').toLowerCase()
      m.speed[kind] = s.note
        ? { number: s.speed, condition: `(${s.note})` }
        : s.speed
      if (/hover/i.test(s.note)) m.speed.canHover = true
    }

    for (const stat of Object.keys(monster.stats) as DndStat[]) {
      m[stat.toLowerCase()] = monster.stats[stat]
    }

    const saves: Record<string, string> = {}
    for (const stat of Object.keys(monster.saves) as DndStat[]) {
      const save = monster.saves[stat]
      if (save.override || save.proficient) {
        saves[stat.toLowerCase()] = renderBonus(saveModifierForStat(monster, stat))
      }
    }
    if (Object.keys(saves).length) m.save = saves

    const skills: Record<string, string> = {}
    for (const skill of monster.skills) {
      if (skill.key === 'INITIATIVE') continue // 2024 only
      skills[t(`skill.${skill.key}`).toLowerCase()] = renderBonus(
        bonusForSkill(monster, skill)
      )
    }
    if (Object.keys(skills).length) m.skill = skills

    const senses = Object.entries(monster.senses)
      .filter(([, range]) => range > 0)
      .map(([sense, range]) => `${sense} ${range} ft.`)
    if (monster.sensesNotes) {
      senses.push(processTokens(monster.sensesNotes, undefined, monster, 'none'))
    }
    if (senses.length) m.senses = senses
    m.passive = monster.computedPassivePerception

    if (monster.resistances.length) m.resist = monster.resistances
    if (monster.immunities.length) m.immune = monster.immunities
    if (monster.vulnerabilities.length) m.vulnerable = monster.vulnerabilities
    if (monster.conditions.length) {
      m.conditionImmune = monster.conditions.map((c) => c.toLowerCase())
    }

    const languages = monster.languages
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    if (languages.length) m.languages = languages

    m.cr = CR[monster.CR].cr

    // traits, then the spellcasting blocks (5etools lists them after the traits)
    const traits: Named[] = monster.traits.map((trait) =>
      splitHeader(processTrait(trait, monster), trait.name)
    )
    if (monster.mythicActions.actions.length > 0) {
      traits.push(
        splitHeader(
          renderer.mythicTrait.value,
          monster.mythicActions.triggerName
        )
      )
    }
    if (monster.lairActions.length > 0) {
      traits.push({
        name: 'Lair Actions',
        entries: [
          ...toEntries(renderer.lairActionPreamble.value),
          {
            type: 'list',
            items: renderer.lairActions.value.flatMap((la) => toEntries(la)),
          },
        ],
      })
    }
    if (monster.regionalEffects.length > 0) {
      traits.push({
        name: 'Regional Effects',
        entries: [
          ...toEntries(renderer.regionalEffectPreamble.value),
          {
            type: 'list',
            items: renderer.regionalEffects.value.flatMap((re) => toEntries(re)),
          },
        ],
      })
    }
    if (monster.inventory) {
      traits.push({
        name: 'Gear',
        entries: toEntries(renderer.inventory.value),
      })
    }
    if (traits.length) m.trait = traits

    const spellcasting = renderSpellcasting()
    if (spellcasting.length) m.spellcasting = spellcasting

    // actions: multiattack, attacks, then the other actions
    const actions: Named[] = []
    if (monster.multiattacks.length > 0) {
      actions.push(
        splitHeader(
          processMultiattack(monster.multiattacks, monster),
          t('editor.multiattack.label')
        )
      )
    }
    for (const attack of monster.attacks.filter((a) => !a.legendaryOnly)) {
      actions.push(renderAttack(attack))
    }
    for (const action of monster.actions.filter(
      (a) => !a.legendaryOnly && !a.bonusAction
    )) {
      actions.push(splitHeader(processAction(action, monster), action.name))
    }
    if (actions.length) m.action = actions

    const bonus = monster.actions
      .filter((a) => !a.legendaryOnly && a.bonusAction)
      .map((a) => splitHeader(processAction(a, monster), a.name))
    if (bonus.length) m.bonus = bonus

    const reactions = monster.reactions.map((r) =>
      splitHeader(processReaction(r, monster), r.name)
    )
    if (reactions.length) m.reaction = reactions

    if (monster.legendaryActions.actions.length > 0) {
      m.legendaryActions = monster.legendaryActions.count
      m.legendaryHeader = toEntries(renderer.legendaryPreamble.value)
      m.legendary = monster.legendaryActions.actions.map((a) =>
        splitHeader(
          processLegendaryAction(a.actionId, a.cost, monster),
          monster.legendaryActionName(a.actionId)
        )
      )
    }

    if (monster.mythicActions.actions.length > 0) {
      m.mythicHeader = toEntries(renderer.mythicPreamble.value)
      m.mythic = monster.mythicActions.actions.map((a) =>
        splitHeader(
          processLegendaryAction(a.actionId, a.cost, monster),
          monster.legendaryActionName(a.actionId)
        )
      )
    }

    const now = Math.floor(Date.now() / 1000)
    return JSON.stringify(
      {
        _meta: {
          sources: [
            {
              ...SOURCE,
              authors: ['GM'],
              convertedBy: ["Falindrith's Monster Maker"],
              version: '1.0.0',
            },
          ],
          dateAdded: now,
          dateLastModified: now,
        },
        monster: [m],
      },
      null,
      2
    )
  }

  return {
    render5etoolsJson,
  }
}
