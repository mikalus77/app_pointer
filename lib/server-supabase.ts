import { createClient } from '@supabase/supabase-js'

function getSupabaseServerEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

  if (!url || !anonKey) {
    throw new Error('Supabase server environment variables are missing.')
  }

  return { url, anonKey }
}

export function createServerSupabaseClient() {
  const { url, anonKey } = getSupabaseServerEnv()
  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
