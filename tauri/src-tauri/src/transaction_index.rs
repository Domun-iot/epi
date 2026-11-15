use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};
use uuid::Uuid;

pub fn parse(contents: &str) -> io::Result<HashSet<Uuid>> {
    contents
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let uuid = Uuid::parse_str(line)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if uuid.to_string() != line {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Index de transactions invalide.",
                ));
            }
            Ok(uuid)
        })
        .collect()
}

pub fn load(root: &Path) -> io::Result<HashSet<Uuid>> {
    match fs::read_to_string(root.join("transactions.index")) {
        Ok(contents) => parse(&contents),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(HashSet::new()),
        Err(error) => Err(error),
    }
}

pub fn add(root: &Path, uuid: Uuid) -> io::Result<()> {
    let mut index = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("transactions.index"))?;
    index.write_all(format!("{uuid}\n").as_bytes())?;
    index.sync_all()
}
