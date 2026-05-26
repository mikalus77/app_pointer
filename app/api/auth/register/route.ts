import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '../../../../lib/server-supabase'
import { hashPassword } from '../../../../lib/password'

type RegisterBody = {
  nom?: string
  prenom?: string
  username?: string
  password?: string
  email?: string
  telephone?: string
  adresse?: string
}

const USERNAME_MAX_LENGTH = 20

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RegisterBody
    const nom = body.nom?.trim() ?? ''
    const prenom = body.prenom?.trim() ?? ''
    const username = body.username?.trim() ?? ''
    const password = body.password ?? ''
    const email = body.email?.trim() ?? ''
    const telephone = body.telephone?.trim() || null
    const adresse = body.adresse?.trim() || null

    if (!nom || !prenom || !username || !password || !email) {
      return NextResponse.json({ error: 'Veuillez remplir les champs obligatoires.' }, { status: 400 })
    }

    if (username.length > USERNAME_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Le nom d'utilisateur doit contenir au maximum ${USERNAME_MAX_LENGTH} caractères.` },
        { status: 400 }
      )
    }

    const supabase = createServerSupabaseClient()

    const { data: statusRow, error: statusError } = await supabase
      .from('statut_utilisateur')
      .select('id_statut_utilisateur')
      .eq('code_statut_utilisateur', 'EN_ATTENTE')
      .eq('actif', true)
      .single()

    if (statusError || !statusRow) {
      return NextResponse.json(
        { error: "Le statut utilisateur 'EN_ATTENTE' est introuvable." },
        { status: 500 }
      )
    }

    const [{ data: existingUsername }, { data: existingEmail }] = await Promise.all([
      supabase
        .from('utilisateur')
        .select('id_utilisateur')
        .eq('username_utilisateur', username)
        .maybeSingle(),
      supabase
        .from('utilisateur')
        .select('id_utilisateur')
        .eq('email_utilisateur', email)
        .maybeSingle(),
    ])

    if (existingUsername) {
      return NextResponse.json({ error: "Ce nom d'utilisateur est déjà utilisé." }, { status: 409 })
    }

    if (existingEmail) {
      return NextResponse.json({ error: 'Cette adresse email est déjà utilisée.' }, { status: 409 })
    }

    const hashedPassword = await hashPassword(password)

    const { error: insertError } = await supabase.from('utilisateur').insert({
      username_utilisateur: username,
      password_utilisateur: hashedPassword,
      nom_utilisateur: nom,
      prenom_utilisateur: prenom,
      email_utilisateur: email,
      telephone_utilisateur: telephone,
      adresse_utilisateur: adresse,
      id_statut_utilisateur: statusRow.id_statut_utilisateur,
    })

    if (insertError) {
      return NextResponse.json({ error: "Impossible d'enregistrer l'inscription." }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: "Impossible d'enregistrer l'inscription." }, { status: 500 })
  }
}
