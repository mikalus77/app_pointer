import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '../../../../lib/server-supabase'
import { hashPassword } from '../../../../lib/password'

type ForgotPasswordBody = {
  username?: string
  newPassword?: string
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ForgotPasswordBody
    const username = body.username?.trim() ?? ''
    const newPassword = body.newPassword ?? ''

    if (!username || !newPassword) {
      return NextResponse.json(
        { error: "Nom d'utilisateur et nouveau mot de passe requis !" },
        { status: 400 }
      )
    }

    const supabase = createServerSupabaseClient()
    const { data: userRow, error: userError } = await supabase
      .from('utilisateur')
      .select('id_utilisateur')
      .eq('username_utilisateur', username)
      .maybeSingle()

    if (userError || !userRow) {
      return NextResponse.json(
        { error: "Nom d'utilisateur introuvable !" },
        { status: 404 }
      )
    }

    const hashedPassword = await hashPassword(newPassword)
    const { error: updateError } = await supabase
      .from('utilisateur')
      .update({ password_utilisateur: hashedPassword })
      .eq('id_utilisateur', userRow.id_utilisateur)

    if (updateError) {
      return NextResponse.json(
        { error: 'Impossible de modifier le mot de passe !' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json(
      { error: 'Impossible de modifier le mot de passe !' },
      { status: 500 }
    )
  }
}
