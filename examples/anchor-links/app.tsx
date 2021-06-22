import React, { ComponentType } from 'react'

const links = {
  'Home': '/',
  'About': '/about',
  'Query #0': '/query',
  'Query #1': '/query?q=hello',
  'Query #2': '/query?q=hello&limit=10&offset=20',
  'Pink': '/colors/pink',
  'Orange': '/colors/orange',
  'Teal': '/colors/teal',
  'Dark Blue': '/colors/darkblue?text=yellow',
  'Dark Green': '/colors/darkgreen?text=orange',
}

export default function App({ Page, pageProps }: { Page: ComponentType<any>, pageProps: any }) {
  return (
    <main>
      <head>
        <meta name="viewport" content="width=device-width" />
        <style>{`
          body {
            font-family: sans-serif;
          }
          nav a {
            margin: 10px;
          }
        `}</style>
      </head>
      <nav>
        {Object.entries(links).map(([name, link]) => (
          <a
            rel="nav"
            href={link}
            data-active-style={{ fontWeight: 'bold' }}
            key={name}
          >{name}</a>
        ))}
      </nav>
      <Page {...pageProps} />
    </main>
  )
}
