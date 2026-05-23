import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
    }
}

@main
struct AgySessionTrayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var viewModel = StatusViewModel()

    var body: some Scene {
        WindowGroup("Antigravity Sessions") {
            StatusView()
                .environmentObject(viewModel)
                .frame(minWidth: 420, idealWidth: 460, minHeight: 620)
                .task {
                    await viewModel.refresh()
                }
        }
        .windowResizability(.contentMinSize)

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
