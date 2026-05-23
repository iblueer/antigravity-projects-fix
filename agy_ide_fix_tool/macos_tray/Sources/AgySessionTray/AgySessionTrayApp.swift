import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

@main
struct AgySessionTrayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var viewModel = StatusViewModel()

    var body: some Scene {
        MenuBarExtra {
            StatusView()
                .environmentObject(viewModel)
                .frame(width: 380)
                .task {
                    await viewModel.refresh()
                }
        } label: {
            Image(systemName: viewModel.statusIcon)
        }
        .menuBarExtraStyle(.window)
    }
}
