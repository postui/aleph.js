use crate::import_map::{ImportHashMap, ImportMap};
use indexmap::IndexSet;
use path_slash::PathBufExt;
use pathdiff::diff_paths;
use regex::Regex;
use relative_path::RelativePath;
use serde::{Deserialize, Serialize};
use std::{
  collections::HashMap,
  path::{Path, PathBuf},
  str::FromStr,
};
use url::Url;

lazy_static! {
  pub static ref RE_ENDS_WITH_VERSION: Regex = Regex::new(
    r"@\d+(\.\d+){0,2}(\-[a-z0-9]+(\.[a-z0-9]+)?)?$"
  )
  .unwrap();
  pub static ref RE_REACT_URL: Regex = Regex::new(
    r"^https?://(esm.sh|cdn.esm.sh|cdn.esm.sh.cn|esm.x-static.io)(/v\d+)?/react(\-dom)?(@[\^|~]{0,1}[0-9a-z\.\-]+)?([/|\?].*)?$"
  )
  .unwrap();
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyDescriptor {
  pub specifier: String,
  pub resolved: String,
  pub is_dynamic: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineStyle {
  pub r#type: String,
  pub quasis: Vec<String>,
  pub exprs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReactOptions {
  #[serde(default)]
  pub version: String,
  #[serde(default)]
  pub esm_sh_build_version: usize,
}

/// A Resolver to resolve aleph.js import/export URL.
pub struct Resolver {
  /// the working dir of aleph app
  pub working_dir: String,
  /// the text specifier associated with the import/export statement.
  pub specifier: String,
  /// a flag indicating if the specifier is remote url or not.
  pub specifier_is_remote: bool,
  /// a flag indicating whether should ignore remote deps.
  pub ignore_remote_deps: bool,
  /// ordered dependencies in the module
  pub deps: Vec<DependencyDescriptor>,
  /// parsed jsx inline styles
  pub inline_styles: HashMap<String, InlineStyle>,
  /// the hash of `ssrProps` function
  pub ssr_props_fn: Option<String>,
  /// the hash of `ssgPaths` function
  pub ssg_paths_fn: Option<bool>,
  /// a hook list of `useDeno`
  pub deno_hooks: Vec<String>,
  /// bundle mode
  pub bundle_mode: bool,
  /// externals for bundle mode
  pub bundle_externals: IndexSet<String>,
  /// all star exports in the module
  pub star_exports: Vec<String>,
  /// added extra imports
  pub extra_imports: IndexSet<String>,
  /// used builtin jsx tags like `a`, `link`, `head`, etc...
  pub used_builtin_jsx_tags: IndexSet<String>,

  // internal
  import_idx: i32,
  import_map: ImportMap,
  aleph_pkg_uri: Option<String>,
  react: Option<ReactOptions>,
}

impl Resolver {
  pub fn new(
    specifier: &str,
    working_dir: &str,
    import_map: ImportHashMap,
    ignore_remote_deps: bool,
    bundle_mode: bool,
    bundle_externals: Vec<String>,
    aleph_pkg_uri: Option<String>,
    react: Option<ReactOptions>,
  ) -> Self {
    let mut tmp = IndexSet::<String>::new();
    for url in bundle_externals {
      tmp.insert(url);
    }
    Resolver {
      working_dir: working_dir.into(),
      specifier: specifier.into(),
      specifier_is_remote: is_remote_url(specifier),
      ignore_remote_deps,
      deps: Vec::new(),
      inline_styles: HashMap::new(),
      ssr_props_fn: None,
      ssg_paths_fn: None,
      deno_hooks: Vec::new(),
      bundle_mode,
      bundle_externals: tmp,
      star_exports: Vec::new(),
      extra_imports: IndexSet::new(),
      used_builtin_jsx_tags: IndexSet::new(),
      import_idx: 0,
      import_map: ImportMap::from_hashmap(import_map),
      aleph_pkg_uri,
      react,
    }
  }

  pub fn get_aleph_pkg_uri(&self) -> String {
    if let Some(aleph_pkg_uri) = &self.aleph_pkg_uri {
      return aleph_pkg_uri.into();
    }
    "https://deno.land/x/aleph".into()
  }

  pub fn add_extra_import(&mut self, url: &str) {
    self.extra_imports.insert(url.into());
  }

  /// fix import/export url.
  //  - `https://esm.sh/react` -> `/-/esm.sh/react.js`
  //  - `https://esm.sh/react@17.0.1?target=es2015&dev` -> `/-/esm.sh/react@17.0.1.[base64('target=es2015&dev')].js`
  //  - `http://localhost:8080/mod` -> `/-/http_localhost_8080/mod.js`
  //  - `/components/x/./logo.tsx` -> `/components/x/logo.tsx`
  //  - `/components/x/../logo.tsx` -> `/components/logo.tsx`
  pub fn fix_import_url(&self, url: &str) -> String {
    let is_remote = is_remote_url(url);
    if !is_remote {
      let mut url = url;
      let mut root = Path::new("");
      if url.starts_with("./") {
        url = url.trim_start_matches(".");
        root = Path::new(".");
      } else if url.starts_with("../") {
        url = url.trim_start_matches("..");
        root = Path::new("..");
      }
      return RelativePath::new(url)
        .normalize()
        .to_path(root)
        .to_slash()
        .unwrap()
        .to_owned();
    }
    let url = Url::from_str(url).unwrap();
    let path = Path::new(url.path());
    let mut path_buf = path.to_owned();
    let mut extname = ".".to_owned();
    extname.push_str(match path.extension() {
      Some(os_str) => match os_str.to_str() {
        Some(s) => {
          if RE_ENDS_WITH_VERSION.is_match(url.path()) {
            "js"
          } else {
            s
          }
        }
        None => "js",
      },
      None => "js",
    });
    if let Some(os_str) = path.file_name() {
      if let Some(s) = os_str.to_str() {
        let extname = extname.as_str();
        let mut file_name = "".to_owned();
        if s.ends_with(extname) {
          file_name.push_str(s.trim_end_matches(extname));
        } else {
          file_name.push_str(s);
        }
        if let Some(q) = url.query() {
          file_name.push('.');
          file_name.push_str(
            base64::encode(q)
              .replace("+", "-")
              .replace("/", "_")
              .replace("=", "")
              .as_str(),
          );
        }
        file_name.push_str(extname);
        path_buf.set_file_name(file_name);
      }
    }
    let mut p = "/-/".to_owned();
    let scheme = url.scheme();
    if scheme == "http" {
      p.push_str("http_");
    }
    p.push_str(url.host_str().unwrap());
    if let Some(port) = url.port() {
      if scheme == "http" && port == 80 {
      } else if scheme == "https" && port == 443 {
      } else {
        p.push('_');
        p.push_str(port.to_string().as_str());
      }
    }
    p.push_str(path_buf.to_slash().unwrap().as_str());
    p
  }

  /// resolve import/export url.
  // [/pages/index.tsx]
  // - `https://esm.sh/swr` -> `../-/esm.sh/swr.js`
  // - `https://esm.sh/react` -> `../-/esm.sh/react@${REACT_VERSION}.js`
  // - `https://deno.land/x/aleph/mod.ts` -> `../-/deno.land/x/aleph@v${ALEPH_VERSION}/mod.ts`
  // - `../components/logo.tsx` -> `../components/logo.js#/components/logo.tsx@000000`
  // - `../styles/app.css` -> `../styles/app.css.js#/styles/app.css@000000`
  pub fn resolve(&mut self, url: &str, is_dynamic: bool) -> (String, String) {
    // apply import map
    let url = self.import_map.resolve(self.specifier.as_str(), url);
    let mut fixed_url: String = if is_remote_url(url.as_str()) {
      url.into()
    } else {
      if self.specifier_is_remote {
        let mut new_url = Url::from_str(self.specifier.as_str()).unwrap();
        if url.starts_with("/") {
          new_url.set_path(url.as_str());
        } else {
          let mut buf = PathBuf::from(new_url.path());
          buf.pop();
          buf.push(url);
          let path = "/".to_owned()
            + RelativePath::new(buf.to_slash().unwrap().as_str())
              .normalize()
              .as_str();
          new_url.set_path(path.as_str());
        }
        new_url.as_str().into()
      } else {
        if url.starts_with("/") {
          url.into()
        } else {
          let mut buf = PathBuf::from(self.specifier.as_str());
          buf.pop();
          buf.push(url);
          "/".to_owned()
            + RelativePath::new(buf.to_slash().unwrap().as_str())
              .normalize()
              .as_str()
        }
      }
    };

    // fix deno.land/x/aleph url
    if let Some(aleph_pkg_uri) = &self.aleph_pkg_uri {
      if fixed_url.starts_with("https://deno.land/x/aleph/") {
        fixed_url = format!(
          "{}/{}",
          aleph_pkg_uri.as_str(),
          fixed_url.trim_start_matches("https://deno.land/x/aleph/")
        );
      }
    }

    // fix react/react-dom url
    if let Some(react) = &self.react {
      if RE_REACT_URL.is_match(fixed_url.as_str()) {
        let caps = RE_REACT_URL.captures(fixed_url.as_str()).unwrap();
        let mut host = caps.get(1).map_or("", |m| m.as_str());
        let build_version = caps
          .get(2)
          .map_or("", |m| m.as_str().trim_start_matches("/v"));
        let dom = caps.get(3).map_or("", |m| m.as_str());
        let ver = caps.get(4).map_or("", |m| m.as_str());
        let path = caps.get(5).map_or("", |m| m.as_str());
        let (target_build_version, should_replace_build_version) = if build_version != ""
          && react.esm_sh_build_version > 0
          && !build_version.eq(react.esm_sh_build_version.to_string().as_str())
        {
          (react.esm_sh_build_version.to_string(), true)
        } else {
          ("".to_owned(), false)
        };
        let non_esm_sh_cdn = match host {
          "esm.sh" | "cdn.esm.sh" | "cdn.esm.sh.cn" | "esm.x-static.io" => false,
          _ => true,
        };
        if non_esm_sh_cdn {
          host = "esm.sh"
        }
        if non_esm_sh_cdn || ver != react.version || should_replace_build_version {
          if should_replace_build_version {
            fixed_url = format!(
              "https://{}/v{}/react{}@{}{}",
              host, target_build_version, dom, react.version, path
            );
          } else if build_version != "" {
            fixed_url = format!(
              "https://{}/v{}/react{}@{}{}",
              host, build_version, dom, react.version, path
            );
          } else {
            fixed_url = format!("https://{}/react{}@{}{}", host, dom, react.version, path);
          }
        }
      }
    }

    let is_remote = is_remote_url(fixed_url.as_str());
    if self.ignore_remote_deps && is_remote {
      return (fixed_url.clone(), fixed_url);
    }

    let mut import_index = "".to_owned();
    let mut resolved_path = if is_remote {
      if self.specifier_is_remote {
        let mut buf = PathBuf::from(self.fix_import_url(self.specifier.as_str()));
        buf.pop();
        diff_paths(
          self.fix_import_url(fixed_url.as_str()),
          buf.to_slash().unwrap(),
        )
        .unwrap()
      } else {
        let mut buf = PathBuf::from(self.specifier.as_str());
        buf.pop();
        diff_paths(
          self.fix_import_url(fixed_url.as_str()),
          buf.to_slash().unwrap(),
        )
        .unwrap()
      }
    } else {
      if self.specifier_is_remote {
        let mut new_url = Url::from_str(self.specifier.as_str()).unwrap();
        if fixed_url.starts_with("/") {
          new_url.set_path(fixed_url.as_str());
        } else {
          let mut buf = PathBuf::from(new_url.path());
          buf.pop();
          buf.push(fixed_url.as_str());
          let path = "/".to_owned()
            + RelativePath::new(buf.to_slash().unwrap().as_str())
              .normalize()
              .as_str();
          new_url.set_path(path.as_str());
        }
        let mut buf = PathBuf::from(self.fix_import_url(self.specifier.as_str()));
        buf.pop();
        diff_paths(
          self.fix_import_url(new_url.as_str()),
          buf.to_slash().unwrap(),
        )
        .unwrap()
      } else {
        if fixed_url.starts_with("/") {
          let mut buf = PathBuf::from(self.specifier.as_str());
          buf.pop();
          diff_paths(fixed_url.clone(), buf.to_slash().unwrap()).unwrap()
        } else {
          PathBuf::from(fixed_url.clone())
        }
      }
    };

    // fix extension & add hash placeholder
    match resolved_path.extension() {
      Some(os_str) => match os_str.to_str() {
        Some(s) => match s {
          "js" | "jsx" | "ts" | "tsx" | "mjs" => {
            let mut filename = resolved_path
              .file_name()
              .unwrap()
              .to_str()
              .unwrap()
              .trim_end_matches(s)
              .to_owned();
            if self.bundle_mode && !is_dynamic {
              filename.push_str("client.");
            }
            filename.push_str("js");
            if !(self.bundle_mode && !is_dynamic) && !is_remote && !self.specifier_is_remote {
              filename.push('#');
              filename.push_str(fixed_url.as_str());
              filename.push('@');
              import_index = format!("{:0>6}", self.import_idx.to_string());
              filename.push_str(import_index.as_str());
            }
            resolved_path.set_file_name(filename);
          }
          _ => {
            let mut filename = resolved_path
              .file_name()
              .unwrap()
              .to_str()
              .unwrap()
              .to_owned();
            if self.bundle_mode && !is_dynamic {
              filename.push_str(".client");
            }
            filename.push_str(".js");
            if !(self.bundle_mode && !is_dynamic) && !is_remote && !self.specifier_is_remote {
              filename.push('#');
              filename.push_str(fixed_url.as_str());
              filename.push('@');
              import_index = format!("{:0>6}", self.import_idx.to_string());
              filename.push_str(import_index.as_str());
            }
            resolved_path.set_file_name(filename);
          }
        },
        None => {}
      },
      None => {}
    };
    let mut resolved_path = resolved_path.to_slash().unwrap();
    if !resolved_path.starts_with("./")
      && !resolved_path.starts_with("../")
      && !resolved_path.starts_with("/")
    {
      resolved_path = "./".to_owned() + resolved_path.as_str();
    }

    if !import_index.is_empty() {
      self.import_idx = self.import_idx + 1;
    }
    self.deps.push(DependencyDescriptor {
      specifier: fixed_url.clone(),
      resolved: resolved_path.clone(),
      is_dynamic,
    });
    println!("deps.push: {}", fixed_url.clone());
    (resolved_path, fixed_url)
  }
}

pub fn is_remote_url(url: &str) -> bool {
  return url.starts_with("https://") || url.starts_with("http://");
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::import_map::ImportHashMap;
  use std::collections::HashMap;

  #[test]
  fn resolver_fix_import_url() {
    let resolver = Resolver::new(
      "/app.tsx",
      "/",
      ImportHashMap::default(),
      false,
      false,
      vec![],
      None,
      None,
    );
    assert_eq!(
      resolver.fix_import_url("https://esm.sh/react"),
      "/-/esm.sh/react.js"
    );
    assert_eq!(
      resolver.fix_import_url("https://esm.sh/react@17.0.1?target=es2015&dev"),
      "/-/esm.sh/react@17.0.1.dGFyZ2V0PWVzMjAxNSZkZXY.js"
    );
    assert_eq!(
      resolver.fix_import_url("https://cdn.esm.sh/v1/react@17.0.1/deno/react.js?target=es2015&dev"),
      "/-/cdn.esm.sh/v1/react@17.0.1/deno/react.dGFyZ2V0PWVzMjAxNSZkZXY.js"
    );
    assert_eq!(
      resolver.fix_import_url("http://localhost:8080/mod"),
      "/-/http_localhost_8080/mod.js"
    );
    assert_eq!(
      resolver.fix_import_url("/components/foo/./logo.tsx"),
      "/components/foo/logo.tsx"
    );
    assert_eq!(
      resolver.fix_import_url("/components/foo/../logo.tsx"),
      "/components/logo.tsx"
    );
    assert_eq!(
      resolver.fix_import_url("/components/../foo/logo.tsx"),
      "/foo/logo.tsx"
    );
    assert_eq!(
      resolver.fix_import_url("/components/logo.tsx"),
      "/components/logo.tsx"
    );
    assert_eq!(
      resolver.fix_import_url("../components/logo.tsx"),
      "../components/logo.tsx"
    );
    assert_eq!(resolver.fix_import_url("./button.tsx"), "./button.tsx");
  }

  #[test]
  fn resolve_local() {
    let mut imports: HashMap<String, String> = HashMap::new();
    imports.insert("@/".into(), "./".into());
    imports.insert("~/".into(), "./".into());
    imports.insert("react".into(), "https://esm.sh/react".into());
    imports.insert("react-dom/".into(), "https://esm.sh/react-dom/".into());
    imports.insert(
      "https://deno.land/x/aleph/".into(),
      "http://localhost:2020/".into(),
    );
    let mut resolver = Resolver::new(
      "/pages/index.tsx",
      "/",
      ImportHashMap {
        imports,
        scopes: HashMap::new(),
      },
      false,
      false,
      vec![],
      None,
      Some(ReactOptions {
        version: "17.0.2".into(),
        esm_sh_build_version: 2,
      }),
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react", false),
      (
        "../-/esm.sh/react@17.0.2.js".into(),
        "https://esm.sh/react@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-refresh", false),
      (
        "../-/esm.sh/react-refresh.js".into(),
        "https://esm.sh/react-refresh".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react@16", false),
      (
        "../-/esm.sh/react@17.0.2.js".into(),
        "https://esm.sh/react@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom", false),
      (
        "../-/esm.sh/react-dom@17.0.2.js".into(),
        "https://esm.sh/react-dom@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom@16.14.0", false),
      (
        "../-/esm.sh/react-dom@17.0.2.js".into(),
        "https://esm.sh/react-dom@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom/server", false),
      (
        "../-/esm.sh/react-dom@17.0.2/server.js".into(),
        "https://esm.sh/react-dom@17.0.2/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom@16.13.1/server", false),
      (
        "../-/esm.sh/react-dom@17.0.2/server.js".into(),
        "https://esm.sh/react-dom@17.0.2/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("react-dom/server", false),
      (
        "../-/esm.sh/react-dom@17.0.2/server.js".into(),
        "https://esm.sh/react-dom@17.0.2/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("react", false),
      (
        "../-/esm.sh/react@17.0.2.js".into(),
        "https://esm.sh/react@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://deno.land/x/aleph/mod.ts", false),
      (
        "../-/http_localhost_2020/mod.js".into(),
        "http://localhost:2020/mod.ts".into()
      )
    );
    assert_eq!(
      resolver.resolve(
        "https://deno.land/x/aleph/framework/react/components/Link.ts",
        false
      ),
      (
        "../-/http_localhost_2020/framework/react/components/Link.js".into(),
        "http://localhost:2020/framework/react/components/Link.ts".into()
      )
    );
    assert_eq!(
      resolver.resolve("../components/logo.tsx", false),
      (
        "../components/logo.js#/components/logo.tsx@000000".into(),
        "/components/logo.tsx".into()
      )
    );
    assert_eq!(
      resolver.resolve("../styles/app.css", false),
      (
        "../styles/app.css.js#/styles/app.css@000001".into(),
        "/styles/app.css".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/tailwindcss/dist/tailwind.min.css", false),
      (
        "../-/esm.sh/tailwindcss/dist/tailwind.min.css.js".into(),
        "https://esm.sh/tailwindcss/dist/tailwind.min.css".into()
      )
    );
    assert_eq!(
      resolver.resolve("@/components/logo.tsx", false),
      (
        "../components/logo.js#/components/logo.tsx@000002".into(),
        "/components/logo.tsx".into()
      )
    );
    assert_eq!(
      resolver.resolve("~/components/logo.tsx", false),
      (
        "../components/logo.js#/components/logo.tsx@000003".into(),
        "/components/logo.tsx".into()
      )
    );
  }

  #[test]
  fn resolve_remote_1() {
    let mut resolver = Resolver::new(
      "https://esm.sh/react-dom",
      "/",
      ImportHashMap::default(),
      false,
      false,
      vec![],
      None,
      Some(ReactOptions {
        version: "17.0.2".into(),
        esm_sh_build_version: 2,
      }),
    );
    assert_eq!(
      resolver.resolve("https://cdn.esm.sh/v1/react@17.0.1/es2020/react.js", false),
      (
        "../cdn.esm.sh/v2/react@17.0.2/es2020/react.js".into(),
        "https://cdn.esm.sh/v2/react@17.0.2/es2020/react.js".into()
      )
    );
    assert_eq!(
      resolver.resolve(
        "https://cdn.esm.sh/v1/react-dom@17.0.1/es2020/react.js",
        false
      ),
      (
        "../cdn.esm.sh/v2/react-dom@17.0.2/es2020/react.js".into(),
        "https://cdn.esm.sh/v2/react-dom@17.0.2/es2020/react.js".into()
      )
    );
    assert_eq!(
      resolver.resolve("./react", false),
      (
        "./react@17.0.2.js".into(),
        "https://esm.sh/react@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("/react", false),
      (
        "./react@17.0.2.js".into(),
        "https://esm.sh/react@17.0.2".into()
      )
    );
  }

  #[test]
  fn resolve_remote_2() {
    let mut resolver = Resolver::new(
      "https://esm.sh/preact/hooks",
      "/",
      ImportHashMap::default(),
      false,
      false,
      vec![],
      None,
      Some(ReactOptions {
        version: "17.0.2".into(),
        esm_sh_build_version: 2,
      }),
    );
    assert_eq!(
      resolver.resolve(
        "https://cdn.esm.sh/v1/preact@10.5.7/es2020/preact.js",
        false
      ),
      (
        "../../cdn.esm.sh/v1/preact@10.5.7/es2020/preact.js".into(),
        "https://cdn.esm.sh/v1/preact@10.5.7/es2020/preact.js".into()
      )
    );
    assert_eq!(
      resolver.resolve("../preact", false),
      ("../preact.js".into(), "https://esm.sh/preact".into())
    );
    assert_eq!(
      resolver.resolve("/preact", false),
      ("../preact.js".into(), "https://esm.sh/preact".into())
    );
  }

  #[test]
  fn resolve_simple_mode() {
    let mut imports: HashMap<String, String> = HashMap::new();
    imports.insert("@/".into(), "./".into());
    imports.insert("~/".into(), "./".into());
    imports.insert("react".into(), "https://esm.sh/react".into());
    imports.insert("react-dom/".into(), "https://esm.sh/react-dom/".into());
    imports.insert(
      "https://deno.land/x/aleph/".into(),
      "http://localhost:2020/".into(),
    );
    let mut resolver = Resolver::new(
      "/pages/index.tsx",
      "/",
      ImportHashMap {
        imports,
        scopes: HashMap::new(),
      },
      true,
      false,
      vec![],
      None,
      Some(ReactOptions {
        version: "17.0.2".into(),
        esm_sh_build_version: 2,
      }),
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react", false),
      (
        "https://esm.sh/react@17.0.2".into(),
        "https://esm.sh/react@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react@16", false),
      (
        "https://esm.sh/react@17.0.2".into(),
        "https://esm.sh/react@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom", false),
      (
        "https://esm.sh/react-dom@17.0.2".into(),
        "https://esm.sh/react-dom@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom@16.14.0", false),
      (
        "https://esm.sh/react-dom@17.0.2".into(),
        "https://esm.sh/react-dom@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom/server", false),
      (
        "https://esm.sh/react-dom@17.0.2/server".into(),
        "https://esm.sh/react-dom@17.0.2/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom@16.13.1/server", false),
      (
        "https://esm.sh/react-dom@17.0.2/server".into(),
        "https://esm.sh/react-dom@17.0.2/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("react-dom/server", false),
      (
        "https://esm.sh/react-dom@17.0.2/server".into(),
        "https://esm.sh/react-dom@17.0.2/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("react", false),
      (
        "https://esm.sh/react@17.0.2".into(),
        "https://esm.sh/react@17.0.2".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://deno.land/x/aleph/mod.ts", false),
      (
        "http://localhost:2020/mod.ts".into(),
        "http://localhost:2020/mod.ts".into()
      )
    );
    assert_eq!(
      resolver.resolve(
        "https://deno.land/x/aleph/framework/react/components/Link.ts",
        false
      ),
      (
        "http://localhost:2020/framework/react/components/Link.ts".into(),
        "http://localhost:2020/framework/react/components/Link.ts".into()
      )
    );
    assert_eq!(
      resolver.resolve("../components/logo.tsx", false),
      (
        "../components/logo.js#/components/logo.tsx@000000".into(),
        "/components/logo.tsx".into()
      )
    );
    assert_eq!(
      resolver.resolve("../styles/app.css", false),
      (
        "../styles/app.css.js#/styles/app.css@000001".into(),
        "/styles/app.css".into()
      )
    );
    assert_eq!(
      resolver.resolve("@/components/logo.tsx", false),
      (
        "../components/logo.js#/components/logo.tsx@000002".into(),
        "/components/logo.tsx".into()
      )
    );
    assert_eq!(
      resolver.resolve("~/components/logo.tsx", false),
      (
        "../components/logo.js#/components/logo.tsx@000003".into(),
        "/components/logo.tsx".into()
      )
    );
    assert_eq!(resolver.deps.len(), 4);
  }
}
