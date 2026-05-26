import { NextResponse } from 'next/server'
import { supabase } from '../../../../lib/supabase'
import { hashPassword, isHashedPassword, verifyPassword } from '../../../../lib/password'
import {
  SESSION_DURATION_MS,
  SESSION_COOKIE_NAME,
  buildSessionCookieOptions,
  createSessionToken,
} from '../../../../lib/session'

function extractRoleCode(row: Record<string, unknown> | null | undefined) {
  if (!row) return null

  const directRole =
    typeof row.code_utilisateur_role === 'string'
      ? row.code_utilisateur_role
      : typeof row.code_role_utilisateur === 'string'
        ? row.code_role_utilisateur
        : null
  if (directRole === 'ADMIN' || directRole === 'EMPLOYE') return directRole

  const nestedRole = row.id_utilisateur_role
  if (Array.isArray(nestedRole) && nestedRole.length > 0) {
    const nested = nestedRole[0] as Record<string, unknown>
    const nestedCode =
      typeof nested?.code_utilisateur_role === 'string'
        ? nested.code_utilisateur_role
        : typeof nested?.code_role_utilisateur === 'string'
          ? nested.code_role_utilisateur
          : null
    if (nestedCode === 'ADMIN' || nestedCode === 'EMPLOYE') return nestedCode
  }

  if (nestedRole && typeof nestedRole === 'object') {
    const nested = nestedRole as Record<string, unknown>
    const nestedCode =
      typeof nested.code_utilisateur_role === 'string'
        ? nested.code_utilisateur_role
        : typeof nested.code_role_utilisateur === 'string'
          ? nested.code_role_utilisateur
          : null
    if (nestedCode === 'ADMIN' || nestedCode === 'EMPLOYE') return nestedCode
  }

  return null
}

function findRoleInUnknown(value: unknown): 'ADMIN' | 'EMPLOYE' | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase()
    if (normalized === 'ADMIN' || normalized === 'EMPLOYE') {
      return normalized
    }
    return null
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
  let userRole: 'ADMIN' | 'EMPLOYE' = 'EMPLOYE'

  const { data: roleLinkRows } = await supabase
    .from('utilisateur_role')
    .select('*')
    .eq('id_utilisateur', userId)
    .limit(10)

  if (!Array.isArray(roleLinkRows) || roleLinkRows.length === 0) {
    return userRole
  }

  // 1) Try to find role code directly in mapping row(s)
  for (const roleRow of roleLinkRows) {
    const directRole =
      extractRoleCode(roleRow as Record<string, unknown>) ?? findRoleInUnknown(roleRow)
    if (directRole) {
      return directRole
    }
  }

  // 2) Try to resolve by numeric FK(s) against likely role tables
  const numericRoleIds = new Set<number>()
  for (const roleRow of roleLinkRows) {
    if (!roleRow || typeof roleRow !== 'object') continue
    for (const [key, value] of Object.entries(roleRow as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase()
      if (!normalizedKey.includes('role')) continue
      if (typeof value === 'number' && Number.isFinite(value)) {
        numericRoleIds.add(value)
      }
    }
  }

  const candidateTables = ['role_utilisateur', 'role', 'utilisateur_roles']
  const candidateIdColumns = ['id_role_utilisateur', 'id_role', 'id_utilisateur_role']

  for (const roleId of numericRoleIds) {
    for (const tableName of candidateTables) {
      for (const idColumn of candidateIdColumns) {
        const { data } = await supabase
          .from(tableName)
          .select('*')
          .eq(idColumn, roleId)
          .maybeSingle()
        const resolved = findRoleInUnknown(data)
        if (resolved) {
          return resolved
        }
      }
    }
  }

  return userRole
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
  } catch {
    return NextResponse.json({ error: 'Impossible de creer la session !' }, { status: 500 })
  }
}
