use crate::error::{DiagnosticBuffer, ErrorBuffer};
use crate::export_names::ExportParser;
use crate::import_map::ImportHashMap;
use crate::jsx::aleph_jsx_fold;
use crate::resolve_fold::resolve_fold;
use crate::resolver::{is_remote_url, DependencyDescriptor, Resolver};
use crate::source_type::SourceType;
use crate::strip_ssr::strip_ssr_fold;

use path_slash::PathBufExt;
use std::{cell::RefCell, cmp::min, path::Path, rc::Rc};
use swc_common::{
  chain,
  comments::SingleThreadedComments,
  errors::{Handler, HandlerFlags},
  FileName, Globals, SourceMap,
};
use swc_ecma_transforms_proposal::decorators;
use swc_ecma_transforms_typescript::strip;
use swc_ecmascript::{
  ast::{Module, Program},
  codegen::{text_writer::JsWriter, Node},
  parser::{lexer::Lexer, EsConfig, JscTarget, StringInput, Syntax, TsConfig},
  transforms::{fixer, helpers, hygiene, pass::Optional, react},
  visit::{Fold, FoldWith},
};

/// Options for transpiling a module.
#[derive(Debug, Clone)]
pub struct EmitOptions {
  pub jsx_factory: String,
  pub jsx_fragment_factory: String,
  pub source_map: bool,
  pub is_dev: bool,
}

impl Default for EmitOptions {
  fn default() -> Self {
    EmitOptions {
      jsx_factory: "React.createElement".into(),
      jsx_fragment_factory: "React.Fragment".into(),
      is_dev: false,
      source_map: false,
    }
  }
}

#[derive(Clone)]
pub struct SWC {
  pub specifier: String,
  pub module: Module,
  pub source_type: SourceType,
  pub source_map: Rc<SourceMap>,
  pub comments: SingleThreadedComments,
}

impl SWC {
  /// parse source code.
  pub fn parse(
    specifier: &str,
    source: &str,
    source_type: Option<SourceType>,
  ) -> Result<Self, anyhow::Error> {
    let source_map = SourceMap::default();
    let source_file = source_map.new_source_file(
      FileName::Real(Path::new(specifier).to_path_buf()),
      source.into(),
    );
    let sm = &source_map;
    let error_buffer = ErrorBuffer::new(specifier);
    let source_type = match source_type {
      Some(source_type) => match source_type {
        SourceType::Unknown => SourceType::from(Path::new(specifier)),
        _ => source_type,
      },
      None => SourceType::from(Path::new(specifier)),
    };
    let syntax = get_syntax(&source_type);
    let input = StringInput::from(&*source_file);
    let comments = SingleThreadedComments::default();
    let lexer = Lexer::new(syntax, JscTarget::Es2020, input, Some(&comments));
    let mut parser = swc_ecmascript::parser::Parser::new_from(lexer);
    let handler = Handler::with_emitter_and_flags(
      Box::new(error_buffer.clone()),
      HandlerFlags {
        can_emit_warnings: true,
        dont_buffer_diagnostics: true,
        ..HandlerFlags::default()
      },
    );
    let module = parser
      .parse_module()
      .map_err(move |err| {
        let mut diagnostic = err.into_diagnostic(&handler);
        diagnostic.emit();
        DiagnosticBuffer::from_error_buffer(error_buffer, |span| sm.lookup_char_pos(span.lo))
      })
      .unwrap();

    Ok(SWC {
      specifier: specifier.into(),
      module,
      source_type,
      source_map: Rc::new(source_map),
      comments,
    })
  }

  /// parse export names in the module.
  pub fn parse_export_names(&self) -> Result<Vec<String>, anyhow::Error> {
    let program = Program::Module(self.module.clone());
    let mut parser = ExportParser { names: vec![] };
    program.fold_with(&mut parser);
    Ok(parser.names)
  }

  pub fn strip_ssr_code(self, source_map: bool) -> Result<(String, Option<String>), anyhow::Error> {
    swc_common::GLOBALS.set(&Globals::new(), || {
      self.apply_fold(
        chain!(strip_ssr_fold(self.specifier.as_str()), strip()),
        source_map,
      )
    })
  }

  /// transform a JS/TS/JSX/TSX file into a JS file, based on the supplied options.
  ///
  /// ### Arguments
  ///
  /// - `resolver` - a resolver to resolve import/export url.
  /// - `options`  - the options for emit code.
  ///
  pub fn transform(
    self,
    resolver: Rc<RefCell<Resolver>>,
    options: &EmitOptions,
  ) -> Result<(String, Option<String>), anyhow::Error> {
    swc_common::GLOBALS.set(&Globals::new(), || {
      let specifier_is_remote = resolver.borrow().specifier_is_remote;
      let bundle_mode = resolver.borrow().bundle_mode;
      let jsx = match self.source_type {
        SourceType::JSX => true,
        SourceType::TSX => true,
        _ => false,
      };
      let passes = chain!(
        Optional::new(
          aleph_jsx_fold(resolver.clone(), self.source_map.clone(), options.is_dev),
          jsx
        ),
        Optional::new(
          react::refresh(
            true,
            Some(react::RefreshOptions {
              refresh_reg: "$RefreshReg$".into(),
              refresh_sig: "$RefreshSig$".into(),
              emit_full_signatures: false,
            }),
            self.source_map.clone(),
            Some(&self.comments),
          ),
          options.is_dev && !specifier_is_remote
        ),
        Optional::new(
          react::jsx(
            self.source_map.clone(),
            Some(&self.comments),
            react::Options {
              pragma: options.jsx_factory.clone(),
              pragma_frag: options.jsx_fragment_factory.clone(),
              // this will use `Object.assign()` instead of the `_extends` helper when spreading props.
              use_builtins: true,
              ..Default::default()
            },
          ),
          jsx
        ),
        resolve_fold(resolver.clone(), self.source_map.clone(), options.is_dev),
        Optional::new(strip_ssr_fold(self.specifier.as_str()), bundle_mode),
        decorators::decorators(decorators::Config {
          legacy: true,
          emit_metadata: false
        }),
        helpers::inject_helpers(),
        strip(),
        fixer(Some(&self.comments)),
        hygiene()
      );

      let (mut code, map) = self.apply_fold(passes, options.source_map).unwrap();
      let mut resolver = resolver.borrow_mut();

      // remove unused deps by tree-shaking
      let mut deps: Vec<DependencyDescriptor> = Vec::new();
      for dep in resolver.deps.clone() {
        if resolver.star_exports.contains(&dep.specifier)
          || code.contains(to_str_lit(dep.resolved.as_str()).as_str())
        {
          deps.push(dep);
        }
      }
      resolver.deps = deps;

      // ignore deps used by SSR
      let has_ssr_options = if let Some(_) = resolver.ssr_props_fn {
        true
      } else if let Some(_) = resolver.ssg_paths_fn {
        true
      } else {
        false
      };
      if !resolver.bundle_mode && (has_ssr_options || !resolver.deno_hooks.is_empty()) {
        let module = SWC::parse(self.specifier.as_str(), code.as_str(), Some(SourceType::JS))
          .expect("could not parse the module");
        let (csr_code, _) = swc_common::GLOBALS.set(&Globals::new(), || {
          module
            .apply_fold(
              chain!(strip_ssr_fold(self.specifier.as_str()), strip()),
              false,
            )
            .unwrap()
        });
        let mut deps: Vec<DependencyDescriptor> = Vec::new();
        for dep in resolver.deps.clone() {
          let s = to_str_lit(dep.resolved.as_str());
          if resolver.star_exports.contains(&dep.specifier) || csr_code.contains(s.as_str()) {
            deps.push(dep);
          } else {
            let mut raw = "\"".to_owned();
            if is_remote_url(dep.specifier.as_str()) {
              raw.push_str(dep.specifier.as_str());
            } else {
              let path = Path::new(resolver.working_dir.as_str());
              let path = path
                .join(dep.specifier.trim_start_matches("/"))
                .to_slash()
                .unwrap();
              raw.push_str(path.as_str());
            }
            raw.push('"');
            code = code.replace(s.as_str(), raw.as_str());
          }
        }
        resolver.deps = deps;
      }

      Ok((code, map))
    })
  }

  /// Apply transform with the fold.
  pub fn apply_fold<T: Fold>(
    &self,
    mut fold: T,
    source_map: bool,
  ) -> Result<(String, Option<String>), anyhow::Error> {
    let program = Program::Module(self.module.clone());
    let program = helpers::HELPERS.set(&helpers::Helpers::new(false), || {
      program.fold_with(&mut fold)
    });
    let mut buf = Vec::new();
    let mut src_map_buf = Vec::new();
    let src_map = if source_map {
      Some(&mut src_map_buf)
    } else {
      None
    };
    {
      let writer = Box::new(JsWriter::new(
        self.source_map.clone(),
        "\n",
        &mut buf,
        src_map,
      ));
      let mut emitter = swc_ecmascript::codegen::Emitter {
        cfg: swc_ecmascript::codegen::Config {
          minify: false, // todo: use swc minify in the future, currently use terser
        },
        comments: Some(&self.comments),
        cm: self.source_map.clone(),
        wr: writer,
      };
      program.emit_with(&mut emitter).unwrap();
    }

    // output
    let src = String::from_utf8(buf).unwrap();
    if source_map {
      let mut buf = Vec::new();
      self
        .source_map
        .build_source_map_from(&mut src_map_buf, None)
        .to_writer(&mut buf)
        .unwrap();
      Ok((src, Some(String::from_utf8(buf).unwrap())))
    } else {
      Ok((src, None))
    }
  }
}

fn get_es_config(jsx: bool) -> EsConfig {
  EsConfig {
    class_private_methods: true,
    class_private_props: true,
    class_props: true,
    dynamic_import: true,
    export_default_from: true,
    export_namespace_from: true,
    num_sep: true,
    nullish_coalescing: true,
    optional_chaining: true,
    top_level_await: true,
    import_meta: true,
    import_assertions: true,
    jsx,
    ..EsConfig::default()
  }
}

fn get_ts_config(tsx: bool) -> TsConfig {
  TsConfig {
    decorators: true,
    dynamic_import: true,
    tsx,
    ..TsConfig::default()
  }
}

fn get_syntax(source_type: &SourceType) -> Syntax {
  match source_type {
    SourceType::JS => Syntax::Es(get_es_config(false)),
    SourceType::JSX => Syntax::Es(get_es_config(true)),
    SourceType::TS => Syntax::Typescript(get_ts_config(false)),
    SourceType::TSX => Syntax::Typescript(get_ts_config(true)),
    _ => Syntax::Es(get_es_config(false)),
  }
}

fn to_str_lit(sub_text: &str) -> String {
  let mut s = "\"".to_owned();
  s.push_str(sub_text);
  s.push('"');
  s
}

#[allow(dead_code)]
pub fn t<T: Fold>(specifier: &str, source: &str, tr: T, expect: &str) -> bool {
  let module = SWC::parse(specifier, source, None).expect("could not parse module");
  let (code, _) =
    swc_common::GLOBALS.set(&Globals::new(), || module.apply_fold(tr, false).unwrap());
  let matched = code.as_str().trim().eq(expect.trim());

  if !matched {
    let mut p: usize = 0;
    for i in 0..min(code.len(), expect.len()) {
      if code.get(i..i + 1) != expect.get(i..i + 1) {
        p = i;
        break;
      }
    }
    println!(
      "{}\x1b[0;31m{}\x1b[0m",
      code.get(0..p).unwrap(),
      code.get(p..).unwrap()
    );
  }
  matched
}

#[allow(dead_code)]
pub fn st(specifer: &str, source: &str, bundle_mode: bool) -> (String, Rc<RefCell<Resolver>>) {
  let module = SWC::parse(specifer, source, None).expect("could not parse module");
  let resolver = Rc::new(RefCell::new(Resolver::new(
    specifer,
    "/test/",
    ImportHashMap::default(),
    false,
    bundle_mode,
    vec![],
    Some("https://deno.land/x/aleph@v0.3.0".into()),
    None,
  )));
  let (code, _) = module
    .transform(resolver.clone(), &EmitOptions::default())
    .unwrap();
  println!("{}", code);
  (code, resolver)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::import_map::ImportHashMap;
  use crate::resolver::{ReactOptions, Resolver};
  use sha1::{Digest, Sha1};
  use std::collections::HashMap;

  #[test]
  fn typescript() {
    let source = r#"
      enum D {
        A,
        B,
        C,
      }

      function enumerable(value: boolean) {
        return function (
          _target: any,
          _propertyKey: string,
          descriptor: PropertyDescriptor,
        ) {
          descriptor.enumerable = value;
        };
      }

      export class A {
        private b: string;
        protected c: number = 1;
        e: "foo";
        constructor (public d = D.A) {
          const e = "foo" as const;
          this.e = e;
        }
        @enumerable(false)
        bar() {}
      }
    "#;
    let (code, _) = st("https://deno.land/x/mod.ts", source, false);
    assert!(code.contains("var D;\n(function(D) {\n"));
    assert!(code.contains("_applyDecoratedDescriptor("));
  }

  #[test]
  fn react_jsx() {
    let source = r#"
      import React from "https://esm.sh/react"
      export default function Index() {
        return (
          <>
            <h1 className="title">Hello World</h1>
          </>
        )
      }
    "#;
    let (code, _) = st("/pages/index.tsx", source, false);
    assert!(code.contains("React.createElement(React.Fragment, null"));
    assert!(code.contains("React.createElement(\"h1\", {"));
    assert!(code.contains("className: \"title\""));
  }

  #[test]
  fn parse_export_names() {
    let source = r#"
      export const name = "alephjs"
      export const version = "1.0.1"
      const start = () => {}
      export default start
      export const { build } = { build: () => {} }
      export function dev() {}
      export class Server {}
      export const { a: { a1, a2 }, 'b': [ b1, b2 ], c, ...rest } = { a: { a1: 0, a2: 0 }, b: [ 0, 0 ], c: 0, d: 0 }
      export const [ d, e, ...{f, g, rest3} ] = [0, 0, {f:0,g:0,h:0}]
      let i
      export const j = i = [0, 0]
      export { exists, existsSync } from "https://deno.land/std/fs/exists.ts"
      export * as DenoStdServer from "https://deno.land/std/http/sever.ts"
      export * from "https://deno.land/std/http/sever.ts"
    "#;
    let module = SWC::parse("/app.ts", source, None).expect("could not parse module");
    assert_eq!(
      module.parse_export_names().unwrap(),
      vec![
        "name",
        "version",
        "default",
        "build",
        "dev",
        "Server",
        "a1",
        "a2",
        "b1",
        "b2",
        "c",
        "rest",
        "d",
        "e",
        "f",
        "g",
        "rest3",
        "j",
        "exists",
        "existsSync",
        "DenoStdServer",
        "{https://deno.land/std/http/sever.ts}",
      ]
      .into_iter()
      .map(|s| s.to_owned())
      .collect::<Vec<String>>()
    )
  }

  #[test]
  fn resolve_module_import_export() {
    let source = r#"
      import React from 'react'
      import { redirect } from 'aleph'
      import { useDeno } from 'aleph/hooks.ts'
      import { render } from 'react-dom/server'
      import { render as _render } from 'https://cdn.esm.sh/v1/react-dom@16.14.1/es2020/react-dom.js'
      import Logo from '../component/logo.tsx'
      import Logo2 from '~/component/logo.tsx'
      import Logo3 from '@/component/logo.tsx'
      const AsyncLogo = React.lazy(() => import('../components/async-logo.tsx'))
      export { useState } from 'https://esm.sh/react'
      export * from 'https://esm.sh/swr'
      export { React, redirect, useDeno, render, _render, Logo, Logo2, Logo3, AsyncLogo }
    "#;
    let module = SWC::parse("/pages/index.tsx", source, None).expect("could not parse module");
    let mut imports: HashMap<String, String> = HashMap::new();
    imports.insert("@/".into(), "./".into());
    imports.insert("~/".into(), "./".into());
    imports.insert("aleph".into(), "https://deno.land/x/aleph/mod.ts".into());
    imports.insert("aleph/".into(), "https://deno.land/x/aleph/".into());
    imports.insert("react".into(), "https://esm.sh/react".into());
    imports.insert("react-dom/".into(), "https://esm.sh/react-dom/".into());
    let resolver = Rc::new(RefCell::new(Resolver::new(
      "/pages/index.tsx",
      "/",
      ImportHashMap {
        imports,
        scopes: HashMap::new(),
      },
      false,
      false,
      vec![],
      Some("https://deno.land/x/aleph@v1.0.0".into()),
      Some(ReactOptions {
        version: "17.0.2".into(),
        esm_sh_build_version: 2,
      }),
    )));
    let code = module
      .transform(resolver.clone(), &EmitOptions::default())
      .unwrap()
      .0;
    println!("{}", code);
    assert!(code.contains("import React from \"../-/esm.sh/react@17.0.2.js\""));
    assert!(code.contains("import { redirect } from \"../-/deno.land/x/aleph@v1.0.0/mod.js\""));
    assert!(code.contains("import { useDeno } from \"../-/deno.land/x/aleph@v1.0.0/hooks.js\""));
    assert!(code.contains("import { render } from \"../-/esm.sh/react-dom@17.0.2/server.js\""));
    assert!(code.contains("import { render as _render } from \"../-/cdn.esm.sh/v2/react-dom@17.0.2/es2020/react-dom.js\""));
    assert!(code.contains("import Logo from \"../component/logo.js#/component/logo.tsx@000000\""));
    assert!(code.contains("import Logo2 from \"../component/logo.js#/component/logo.tsx@000001\""));
    assert!(code.contains("import Logo3 from \"../component/logo.js#/component/logo.tsx@000002\""));
    assert!(code.contains("const AsyncLogo = React.lazy(()=>import(\"../components/async-logo.js#/components/async-logo.tsx@000003\")"));
    assert!(code.contains("export { useState } from \"../-/esm.sh/react@17.0.2.js\""));
    assert!(code.contains("export * from \"[https://esm.sh/swr]:../-/esm.sh/swr.js\""));
    assert_eq!(
      resolver.borrow().deps.last().unwrap().specifier,
      "https://esm.sh/swr"
    );
  }

  #[test]
  fn sign_use_deno_hook() {
    let specifer = "/pages/index.tsx";
    let source = r#"
      const callback = async () => {
        return {}
      }

      export default function Index() {
        const verison = useDeno(() => Deno.version)
        const data = useDeno(async function() {
          return await readJson("./data.json")
        }, 1000)
        const data = useDeno(callback, 1000, "ID")
        return null
      }
    "#;

    let mut hasher = Sha1::new();
    hasher.update(specifer.clone());
    hasher.update("1");
    hasher.update("() => Deno.version");
    let id_1 = base64::encode(hasher.finalize())
      .replace("/", "")
      .replace("+", "")
      .replace("=", "");

    let mut hasher = Sha1::new();
    hasher.update(specifer.clone());
    hasher.update("2");
    hasher.update(
      r#"async function() {
          return await readJson("./data.json")
        }"#,
    );
    let id_2 = base64::encode(hasher.finalize())
      .replace("+", "")
      .replace("/", "")
      .replace("=", "");

    let mut hasher = Sha1::new();
    hasher.update(specifer.clone());
    hasher.update("3");
    hasher.update("callback");
    let id_3 = base64::encode(hasher.finalize())
      .replace("+", "")
      .replace("/", "")
      .replace("=", "");

    let (code, _) = st(specifer, source, false);
    assert!(code.contains(format!(", null, \"useDeno-{}\"", id_1).as_str()));
    assert!(code.contains(format!(", 1000, \"useDeno-{}\"", id_2).as_str()));
    assert!(code.contains(format!(", 1000, \"useDeno-{}\"", id_3).as_str()));

    let (code, _) = st(specifer, source, true);
    assert!(code.contains(format!("null, null, \"useDeno-{}\"", id_1).as_str()));
    assert!(code.contains(format!("null, 1000, \"useDeno-{}\"", id_2).as_str()));
    assert!(code.contains(format!("null, 1000, \"useDeno-{}\"", id_3).as_str()));
  }

  #[test]
  fn resolve_import_meta_url() {
    let source = r#"
      console.log(import.meta.url)
    "#;
    let (code, _) = st("/pages/index.tsx", source, false);
    assert!(code.contains("console.log(\"/test/pages/index.tsx\")"));
  }

  #[test]
  fn ssr_tree_shaking() {
    let source = r#"
      import { useDeno } from 'https://deno.land/x/aleph/framework/react/mod.ts'
      import { join, basename, dirname } from 'https://deno.land/std/path/mod.ts'
      import React from 'https://esm.sh/react'
      import { get } from '../libs/db.ts'

      export const ssrProps = async () => ({
        filename: basename(import.meta.url),
        data: get('foo')
      })

      export const ssgPaths = async () => ([join('/', 'foo')])

      export default function Index() {
        const { title } = useDeno(async () => {
          const text = await Deno.readTextFile(join(dirname(import.meta.url), '../config.json'))
          return JSON.parse(text)
        })

        return (
          <h1>{title}</h1>
        )
      }
    "#;
    let module = SWC::parse("/pages/index.tsx", source, None).expect("could not parse module");
    let resolver = Rc::new(RefCell::new(Resolver::new(
      "/pages/index.tsx",
      "/test",
      ImportHashMap::default(),
      false,
      false,
      vec![],
      None,
      None,
    )));
    let code = module
      .transform(resolver.clone(), &EmitOptions::default())
      .unwrap()
      .0;
    println!("{}", code);
    assert!(
      code.contains("import { useDeno } from \"../-/deno.land/x/aleph/framework/react/mod.js\"")
    );
    assert!(code.contains("import React from \"../-/esm.sh/react.js\""));
    assert!(code
      .contains("import { join, basename, dirname } from \"https://deno.land/std/path/mod.ts\""));
    assert!(code.contains("import { get } from \"/test/libs/db.ts\""));
    assert!(code.contains("export const ssrProps ="));
    assert_eq!(resolver.borrow().deno_hooks.len(), 1);
    assert_eq!(resolver.borrow().deps.len(), 2);

    let mut hasher = Sha1::new();
    let callback_code = r#"ssrProps = async () => ({
        filename: basename(import.meta.url),
        data: get('foo')
      })"#;
    hasher.update(callback_code.clone());
    assert_eq!(
      resolver.borrow().ssr_props_fn,
      Some(base64::encode(hasher.finalize()))
    );

    assert_eq!(resolver.borrow().ssg_paths_fn, Some(true));
  }

  #[test]
  fn bundle_mode() {
    let source = r#"
      import { useDeno } from 'https://deno.land/x/aleph/framework/react/mod.ts'
      import { join, basename, dirname } from 'https://deno.land/std/path/mod.ts'
      import React, { useState, useEffect as useEffect_ } from 'https://esm.sh/react'
      import * as React_ from 'https://esm.sh/react'
      import Logo from '../components/logo.tsx'
      import Nav from '../components/nav.tsx'
      import '../shared/iife.ts'
      import '../shared/iife2.ts'
      export * from "https://esm.sh/react"
      export * as ReactDom from "https://esm.sh/react-dom"
      export { render } from "https://esm.sh/react-dom"

      const AsyncLogo = React.lazy(() => import('../components/async-logo.tsx'))

      export const ssrProps = async () => ({
        filename: basename(import.meta.url)
      })
      export const ssgPaths = async () => ([join('/', 'foo')])

      export default function Index() {
        const { title } = useDeno(async () => {
          const text = await Deno.readTextFile(join(dirname(import.meta.url), '../config.json'))
          return JSON.parse(text)
        })

        return (
          <>
            <head>
              <link rel="stylesheet" href="https://esm.sh/tailwindcss/dist/tailwind.min.css" />
              <link rel="stylesheet" href="../style/index.css" />
            </head>
            <Logo />
            <AsyncLogo />
            <Nav />
            <h1>{title}</h1>
          </>
        )
      }
    "#;
    let module = SWC::parse("/pages/index.tsx", source, None).expect("could not parse module");
    let resolver = Rc::new(RefCell::new(Resolver::new(
      "/pages/index.tsx",
      "/",
      ImportHashMap::default(),
      false,
      true,
      vec![
        "https://esm.sh/react".into(),
        "https://esm.sh/react-dom".into(),
        "https://deno.land/x/aleph/framework/react/mod.ts".into(),
        "https://deno.land/x/aleph/framework/react/components/Head.ts".into(),
        "/components/logo.tsx".into(),
        "/shared/iife.ts".into(),
      ],
      None,
      None,
    )));
    let code = module
      .transform(resolver.clone(), &EmitOptions::default())
      .unwrap()
      .0;
    println!("{}", code);
    assert!(code.contains("const { /*#__PURE__*/ default: React , useState , useEffect: useEffect_  } = __ALEPH.pack[\"https://esm.sh/react\"]"));
    assert!(code.contains("const React_ = __ALEPH.pack[\"https://esm.sh/react\"]"));
    assert!(code.contains("const { default: Logo  } = __ALEPH.pack[\"/components/logo.tsx\"]"));
    assert!(code.contains("import Nav from \"../components/nav.client.js\""));
    assert!(!code.contains("__ALEPH.pack[\"/shared/iife.ts\"]"));
    assert!(code.contains("import   \"../shared/iife2.client.js\""));
    assert!(
      code.contains("AsyncLogo = React.lazy(()=>__ALEPH.import(\"/components/async-logo.tsx\"")
    );
    assert!(code.contains(
      "const { default: __ALEPH_Head  } = __ALEPH.pack[\"https://deno.land/x/aleph/framework/react/components/Head.ts\"]"
    ));
    assert!(code.contains(
      "import __ALEPH_StyleLink from \"../-/deno.land/x/aleph/framework/react/components/StyleLink.client.js\""
    ));
    assert!(code.contains("import   \"../-/esm.sh/tailwindcss/dist/tailwind.min.css.client.js\""));
    assert!(code.contains("import   \"../style/index.css.client.js\""));
    assert!(code.contains("export const $$star_0 = __ALEPH.pack[\"https://esm.sh/react\"]"));
    assert!(code.contains("export const ReactDom = __ALEPH.pack[\"https://esm.sh/react-dom\"]"));
    assert!(code.contains("export const { render  } = __ALEPH.pack[\"https://esm.sh/react-dom\"]"));
    assert!(!code.contains("export const ssrProps ="));
    assert!(!code.contains("export const ssgPaths ="));
    assert!(!code.contains("deno.land/std/path"));
  }
}
