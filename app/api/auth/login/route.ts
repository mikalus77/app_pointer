import { NextResponse } from 'next/server'
import { supabase } from '../../../../lib/supabase'
import {
  SESSION_DURATION_MS,
  SESSION_COOKIE_NAME,
  buildSessionCookieOptions,
  createSessionToken,
} from '../../../../lib/session'

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { username?: string; password?: string }
    const username = body.username?.trim() ?? ''
    const password = body.password ?? ''

    if (!username || !password) {
      return NextResponse.json(
        { error: "Nom d'utilisateur ou mot de passe manquant." },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('utilisateur')
      .select('id_utilisateur, username_utilisateur')
      .eq('username_utilisateur', username)
      .eq('password_utilisateur', password)
      .eq('actif', true)
      .single()

    if (error || !data) {
      return NextResponse.json(
        { error: "Nom d'utilisateur ou mot de passe incorrect." },
        { status: 401 }
      )
    }

    const expiresAt = Date.now() + SESSION_DURATION_MS
    const token = await createSessionToken({
      userId: data.id_utilisateur,
      username: data.username_utilisateur ?? username,
      expiresAt,
    })

    const response = NextResponse.json({
      userId: data.id_utilisateur,
      username: data.username_utilisateur ?? username,
    })

    response.cookies.set(SESSION_COOKIE_NAME, token, buildSessionCookieOptions(expiresAt))

    return response
  } catch {
    return NextResponse.json({ error: 'Impossible de creer la session.' }, { status: 500 })
  }
}
