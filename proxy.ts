import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, verifySessionToken } from './lib/session'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value
  const session = await verifySessionToken(sessionToken)

  if (pathname === '/') {
    if (session) {
      return NextResponse.redirect(new URL('/accueil', request.url))
    }
    return NextResponse.next()
  }

  if (!session) {
    const response = NextResponse.redirect(new URL('/', request.url))
    if (sessionToken) {
      response.cookies.delete(SESSION_COOKIE_NAME)
    }
    return response
  }

  const isAdminRoute =
    pathname.startsWith('/utilisateurs') || pathname.startsWith('/gestion-des-activites')
  if (isAdminRoute && session.role !== 'ADMIN') {
    return NextResponse.redirect(new URL('/accueil', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/',
    '/accueil/:path*',
    '/pointage/:path*',
    '/taches/:path*',
    '/utilisateurs/:path*',
    '/gestion-des-activites/:path*',
  ],
}
