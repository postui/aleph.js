import { useDeno } from 'framework/react'
import React from 'react'

export default function About() {
  const version = useDeno(() => Deno.version.deno)

  return (
    <div>
      <head>
        <title>About</title>
        <style>{`
          body {
            background: pink;
          }
        `}</style>
      </head>
      <div>
        <h1>About page</h1>
        <p>Deno version: {version}</p>
      </div>
    </div>
  )
}
