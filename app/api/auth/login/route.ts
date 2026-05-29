import { NextResponse } from 'next/server'
import { supabase } from '../../../../lib/supabase'
import { hashPassword, isHashedPassword, verifyPassword } from '../../../../lib/password'
import {
  SESSION_DURATION_MS,
  SESSION_COOKIE_NAME,
  buildSessionCookieOptions,
  createSessionToken,
} from '../../../../lib/session'

type AppRole = 'ADMIN' | 'EMPLOYE' | 'INTERVENANT' | 'RESPONSABLE_INTERVENTION'

function normalizeRoleCode(value: unknown): AppRole | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (
    normalized === 'ADMIN' ||
    normalized === 'EMPLOYE' ||
    normalized === 'INTERVENANT' ||
    normalized === 'RESPONSABLE_INTERVENTION'
  ) {
    return normalized
  }
  return null
}

function extractRoleCode(row: Record<string, unknown> | null | undefined) {
  if (!row) return null

  const directRole =
    typeof row.code_utilisateur_role === 'string'
      ? row.code_utilisateur_role
      : typeof row.code_role_utilisateur === 'string'
        ? row.code_role_utilisateur
        : null
  const normalizedDirect = normalizeRoleCode(directRole)
  if (normalizedDirect) return normalizedDirect

  const nestedRole = row.id_utilisateur_role
  if (Array.isArray(nestedRole) && nestedRole.length > 0) {
    const nested = nestedRole[0] as Record<string, unknown>
    const nestedCode =
      typeof nested?.code_utilisateur_role === 'string'
        ? nested.code_utilisateur_role
        : typeof nested?.code_role_utilisateur === 'string'
          ? nested.code_role_utilisateur
          : null
    const normalizedNested = normalizeRoleCode(nestedCode)
    if (normalizedNested) return normalizedNested
  }

  if (nestedRole && typeof nestedRole === 'object') {
    const nested = nestedRole as Record<string, unknown>
    const nestedCode =
      typeof nested.code_utilisateur_role === 'string'
        ? nested.code_utilisateur_role
        : typeof nested.code_role_utilisateur === 'string'
          ? nested.code_role_utilisateur
          : null
    const normalizedNested = normalizeRoleCode(nestedCode)
    if (normalizedNested) return normalizedNested
  }

  return null
}

function findRoleInUnknown(value: unknown): AppRole | null {
  if (typeof value === 'string') {
    return normalizeRoleCode(value)
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const role = findRoleInUnknown(entry)
      if (role) return role
    }
    return null
  }

  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      const role = findRoleInUnknown(nestedValue)
      if (role) return role
    }
  }

  return null
}

async function resolveRoleFromLinkTable(userId: number) {
  try {
    const { data: roleLinkRows } = await supabase
      .from('utilisateur_role')
      .select('*')
      .eq('id_utilisateur', userId)
      .limit(10)

    if (!Array.isArray(roleLinkRows) || roleLinkRows.length === 0) {
      return 'EMPLOYE' as const
    }

    // 1) Code role directly present on mapping rows
    for (const roleRow of roleLinkRows) {
      const resolved = extractRoleCode(roleRow as Record<string, unknown>) ?? findRoleInUnknown(roleRow)
      if (resolved) {
        return resolved
      }
    }

    // 2) Try known nested relations (if declared in PostgREST schema)
    const relationSelects = [
      '*, role_utilisateur(*)',
      '*, utilisateur_role(*)',
      '*, role(*)',
    ]
    for (const selectSpec of relationSelects) {
      const { data: linkedRows, error } = await supabase
        .from('utilisateur_role')
        .select(selectSpec)
        .eq('id_utilisateur', userId)
        .limit(10)
      if (error || !Array.isArray(linkedRows)) continue
      for (const row of linkedRows) {
        const resolved = findRoleInUnknown(row)
        if (resolved) return resolved
      }
    }

    // 3) Resolve numeric role ids via common lookup table names
    const numericRoleIds = new Set<number>()
    for (const roleRow of roleLinkRows) {
      if (!roleRow || typeof roleRow !== 'object') continue
      for (const [key, value] of Object.entries(roleRow as Record<string, unknown>)) {
        if (!key.toLowerCase().includes('role')) continue
        if (typeof value === 'number' && Number.isFinite(value)) {
          numericRoleIds.add(value)
        }
      }
    }

    const candidateTables = ['role_utilisateur', 'utilisateur_role_type', 'role']
    const candidateIdColumns = ['id_role_utilisateur', 'id_utilisateur_role', 'id_role']
    for (const roleId of numericRoleIds) {
      for (const tableName of candidateTables) {
        for (const idColumn of candidateIdColumns) {
          const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .eq(idColumn, roleId)
            .maybeSingle()
          if (error || !data) continue
          const resolved = findRoleInUnknown(data)
          if (resolved) return resolved
        }
      }
    }

    return 'EMPLOYE' as const
  } catch {
    return 'EMPLOYE' as const
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { username?: string; password?: string }
    const username = body.username?.trim() ?? ''
    const password = body.password ?? ''

    if (!username || !password) {
      return NextResponse.json(
        { error: "Nom d'utilisateur ou mot de passe manquant !" },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('utilisateur')
      .select(
        'id_utilisateur, username_utilisateur, password_utilisateur, id_statut_utilisateur!inner(code_statut_utilisateur)'
      )
      .eq('username_utilisateur', username)
      .single()

    if (error || !data) {
      return NextResponse.json(
        { error: "Nom d'utilisateur ou mot de passe incorrect !" },
        { status: 401 }
      )
    }

    const storedPassword = data.password_utilisateur ?? ''
    const isPasswordValid = isHashedPassword(storedPassword)
      ? await verifyPassword(password, storedPassword)
      : storedPassword === password

    if (!isPasswordValid) {
      return NextResponse.json(
        { error: "Nom d'utilisateur ou mot de passe incorrect !" },
        { status: 401 }
      )
    }

    if (!isHashedPassword(storedPassword)) {
      const upgradedPassword = await hashPassword(password)
      await supabase
        .from('utilisateur')
        .update({ password_utilisateur: upgradedPassword })
        .eq('id_utilisateur', data.id_utilisateur)
    }

    const userStatusCode =
      Array.isArray(data.id_statut_utilisateur) && data.id_statut_utilisateur.length > 0
        ? data.id_statut_utilisateur[0]?.code_statut_utilisateur
        : (data.id_statut_utilisateur as { code_statut_utilisateur?: string } | null)
            ?.code_statut_utilisateur

    if (userStatusCode === 'EN_ATTENTE') {
      return NextResponse.json(
        { error: 'Votre compte est en attente de validation !' },
        { status: 403 }
      )
    }

    if (userStatusCode === 'DESACTIVE') {
      return NextResponse.json({ error: 'Votre compte est désactivé !' }, { status: 403 })
    }

    if (userStatusCode !== 'ACTIVE') {
      return NextResponse.json(
        { error: "Votre compte n'est pas autorisé à se connecter !" },
        { status: 403 }
      )
    }

    const userRole = await resolveRoleFromLinkTable(data.id_utilisateur)

    const expiresAt = Date.now() + SESSION_DURATION_MS
    const token = await createSessionToken({
      userId: data.id_utilisateur,
      username: data.username_utilisateur ?? username,
      role: userRole,
      expiresAt,
    })

    const response = NextResponse.json({
      userId: data.id_utilisateur,
      username: data.username_utilisateur ?? username,
      role: userRole,
    })

    response.cookies.set(SESSION_COOKIE_NAME, token, buildSessionCookieOptions(expiresAt))

    return response
  } catch (error) {
    console.error('Login route error:', error)
    return NextResponse.json({ error: 'Impossible de creer la session !' }, { status: 500 })
  }
}
