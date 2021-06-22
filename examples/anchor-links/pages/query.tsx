import { useDeno, useRouter } from 'framework/react'
import React from 'react'

export default function Query() {
  const router = useRouter()
  const qs = useDeno(() => {
    const q = Object.fromEntries(router.query.entries())
    return JSON.stringify(q, undefined, 2)
  })

  return (
    <div>
      <head>
        <title>Query</title>
        <style>{`
          body {
            background: #333;
            color: lightgreen;
          }
          nav a {
            color: teal;
          }
        `}</style>
      </head>
      <div>
        <h1>Query Debug</h1>
        <pre>{qs}</pre>
      </div>
    </div>
  )
}
