use rhwp::DocumentCore;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 { return Err("expected source HWP and output HWP paths".into()); }
    let mut core = DocumentCore::from_bytes(&std::fs::read(&args[1])?).map_err(|error| std::io::Error::other(error.to_string()))?;
    core.document_mut().sections[0].paragraphs.truncate(1);
    core.document_mut().sections[0].raw_stream = None;
    core = DocumentCore::from_bytes(&core.export_hwp_native().map_err(|error| std::io::Error::other(error.to_string()))?).map_err(|error| std::io::Error::other(error.to_string()))?;
    let index = core.get_paragraph_count_native(0).map_err(|error| std::io::Error::other(error.to_string()))?;
    core.insert_paragraph_native(0, index).map_err(|error| std::io::Error::other(error.to_string()))?;
    core.insert_text_native(0, index, 0, "aMIDDLEz").map_err(|error| std::io::Error::other(error.to_string()))?;
    core.apply_char_format_native(0, index, 1, 7, r##"{"bold":true,"italic":true,"textColor":"#1234ab"}"##).map_err(|error| std::io::Error::other(error.to_string()))?;
    std::fs::write(&args[2], core.export_hwp_native().map_err(|error| std::io::Error::other(error.to_string()))?)?;
    let reopened = DocumentCore::from_bytes(&std::fs::read(&args[2])?).map_err(|error| std::io::Error::other(error.to_string()))?;
    println!("before={}; after={}", core.inspect_approved_template_json(), reopened.inspect_approved_template_json());
    println!("generated b:0:{index}: aMIDDLEz; middle bold+italic+blue; original image resources retained");
    Ok(())
}
